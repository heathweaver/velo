import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync, type SyncProgress } from "./sync";
import { getAccount, clearAccountHistoryId, setAccountSyncWindow } from "../db/accounts";
import { needsFullRescan } from "../sync/syncWindow";
import { getSetting } from "../db/settings";
import { getThreadCountForAccount, deleteAllThreadsForAccount } from "../db/threads";
import { getMessageCountForAccount } from "../db/messages";
import { deleteAllMessagesForAccount } from "../db/messages";
import { imapInitialSync, imapDeltaSync } from "../imap/imapSync";
import { clearAllFolderSyncStates } from "../db/folderSyncState";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import { hasCalendarSupport, getCalendarProvider } from "../calendar/providerFactory";
import { getVisibleCalendars, upsertCalendar, updateCalendarSyncToken } from "../db/calendars";
import { upsertCalendarEvent, deleteEventByRemoteId } from "../db/calendarEvents";

const SYNC_INTERVAL_MS = 30_000; // 30 seconds — delta syncs are lightweight; balances "new mail shows quickly" against IMAP-server throttling

/** Map IMAP sync phases to the SyncProgress phases the UI understands. */
function mapImapPhase(phase: string): "labels" | "threads" | "messages" | "done" {
  if (phase === "folders") return "labels";
  if (phase === "threading" || phase === "storing_threads") return "threads";
  if (phase === "messages") return "messages";
  if (phase === "done") return "done";
  return phase as "labels" | "threads" | "messages" | "done";
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncPromise: Promise<void> | null = null;
let pendingAccountIds: string[] | null = null;

export type SyncStatusCallback = (
  accountId: string,
  status: "syncing" | "done" | "error",
  progress?: SyncProgress,
  error?: string,
) => void;

let statusCallback: SyncStatusCallback | null = null;

export function onSyncStatus(cb: SyncStatusCallback): () => void {
  statusCallback = cb;
  return () => {
    statusCallback = null;
  };
}

/**
 * Run a sync for a single Gmail API account (initial or delta).
 */
async function syncGmailAccount(accountId: string): Promise<void> {
  const client = await getGmailClient(accountId);
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  // 0 means "everything" and must survive parsing — `|| 30` would turn it back
  // into a 30-day window because 0 is falsy.
  const parsedSyncDays = parseInt(syncPeriodStr ?? "30", 10);
  const syncDays = Number.isNaN(parsedSyncDays) ? 30 : parsedSyncDays;

  // Gmail's history id only moves forward, so a widened window cannot be
  // honoured by asking for what changed — the mail that is missing is older
  // than the mark. Drop the history id and let the initial-sync path below run
  // again. Without this, choosing "All emails" changed nothing at all.
  const gmailWindowWidened =
    account.provider === "gmail_api" &&
    !!account.history_id &&
    needsFullRescan(account.sync_window_days, syncDays);

  if (gmailWindowWidened) {
    console.warn(
      `[syncManager] Sync window widened for ${accountId} — re-running the initial sync to fetch older mail`,
    );
    await clearAccountHistoryId(accountId);
  }

  if (account.history_id && !gmailWindowWidened) {
    // Delta sync
    try {
      await deltaSync(client, accountId, account.history_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (message === "HISTORY_EXPIRED") {
        // Fallback to full sync
        await initialSync(client, accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", progress);
        });
      } else {
        throw err;
      }
    }
  } else {
    // First time — full initial sync
    await initialSync(client, accountId, syncDays, (progress) => {
      statusCallback?.(accountId, "syncing", progress);
    });
  }

  // Record what the mailbox has actually been walked under, so the next
  // widening is detectable. Written after the sync rather than before, so a
  // failed run does not claim coverage it never achieved.
  await setAccountSyncWindow(accountId, syncDays);
}

/**
 * Run a sync for a single IMAP account (initial or delta).
 */
async function syncImapAccount(accountId: string): Promise<void> {
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  // Refresh OAuth2 token before syncing (if applicable)
  if (account.auth_method === "oauth2") {
    await ensureFreshToken(account);
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  // 0 means "everything" and must survive parsing — `|| 30` would turn it back
  // into a 30-day window because 0 is falsy.
  const parsedSyncDays = parseInt(syncPeriodStr ?? "30", 10);
  const syncDays = Number.isNaN(parsedSyncDays) ? 30 : parsedSyncDays;

  if (account.history_id) {
    // Delta sync — IMAP uses folder-level UID tracking
    const result = await imapDeltaSync(accountId, syncDays);

    // Recovery: an account that has genuinely stored nothing gets a full
    // re-sync, because its first one must have failed.
    //
    // This is destructive — it throws away every folder's UID state and
    // re-downloads the mailbox — so it demands more proof than it used to. It
    // fired once on an account holding 300+ threads, wiping its sync state,
    // because a count taken during heavy write load came back 0 and "the query
    // told me nothing" was indistinguishable from "there is nothing". Now both
    // threads *and* messages must be absent, and a count that throws aborts
    // the recovery rather than triggering it.
    //
    // Threads missing while messages exist is no longer a reason to re-sync at
    // all: that is an interrupted run, and repairMissingThreadLabels rebuilds
    // it from what is already on disk.
    // Delta sync streams bodies to disk, so `messages` is always empty and only
    // the count says whether anything arrived. Reading the array here would arm
    // the destructive recovery below on every single sync.
    if ((result.storedCount ?? result.messages.length) === 0) {
      let storedNothing = false;
      try {
        const [threadCount, messageCount] = await Promise.all([
          getThreadCountForAccount(accountId),
          getMessageCountForAccount(accountId),
        ]);
        storedNothing = threadCount === 0 && messageCount === 0;
      } catch (err) {
        console.warn(
          `[syncManager] Could not confirm whether ${accountId} is empty — skipping full re-sync:`,
          err,
        );
      }

      if (storedNothing) {
        console.warn(`[syncManager] IMAP delta sync returned 0 new messages and ${accountId} has stored nothing — forcing full re-sync`);
        await clearAccountHistoryId(accountId);
        await clearAllFolderSyncStates(accountId);
        await imapInitialSync(accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", {
            phase: mapImapPhase(progress.phase),
            current: progress.current,
            total: progress.total,
          });
        });
      }
    }
  } else {
    // First time — full initial sync
    await imapInitialSync(accountId, syncDays, (progress) => {
      statusCallback?.(accountId, "syncing", {
        phase: mapImapPhase(progress.phase),
        current: progress.current,
        total: progress.total,
      });
    });
  }
}

/**
 * Sync calendars for a single account via the CalendarProvider abstraction.
 * Discovers calendars, syncs events for each visible calendar, stores results in DB.
 */
async function syncCalendarForAccount(accountId: string): Promise<void> {
  try {
    const supported = await hasCalendarSupport(accountId);
    if (!supported) return;

    const provider = await getCalendarProvider(accountId);

    // Discover/update calendars
    const calendarInfos = await provider.listCalendars();
    for (const cal of calendarInfos) {
      await upsertCalendar({
        accountId,
        provider: provider.type,
        remoteId: cal.remoteId,
        displayName: cal.displayName,
        color: cal.color,
        isPrimary: cal.isPrimary,
      });
    }

    // Sync events for each visible calendar
    const visibleCals = await getVisibleCalendars(accountId);
    for (const cal of visibleCals) {
      try {
        const syncResult = await provider.syncEvents(cal.remote_id, cal.sync_token ?? undefined);

        // Upsert created/updated events
        for (const event of [...syncResult.created, ...syncResult.updated]) {
          await upsertCalendarEvent({
            accountId,
            googleEventId: event.remoteEventId,
            summary: event.summary,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            isAllDay: event.isAllDay,
            status: event.status,
            organizerEmail: event.organizerEmail,
            attendeesJson: event.attendeesJson,
            htmlLink: event.htmlLink,
            calendarId: cal.id,
            remoteEventId: event.remoteEventId,
            etag: event.etag,
            icalData: event.icalData,
            uid: event.uid,
          });
        }

        // Delete removed events
        for (const remoteId of syncResult.deletedRemoteIds) {
          await deleteEventByRemoteId(cal.id, remoteId);
        }

        // Update sync token
        if (syncResult.newSyncToken || syncResult.newCtag) {
          await updateCalendarSyncToken(cal.id, syncResult.newSyncToken, syncResult.newCtag);
        }
      } catch (err) {
        console.warn(`[syncManager] Calendar sync failed for ${cal.display_name ?? cal.remote_id}:`, err);
      }
    }

    // Emit event for UI update
    window.dispatchEvent(new CustomEvent("velo-calendar-sync-done"));
  } catch (err) {
    console.warn(`[syncManager] Calendar sync failed for account ${accountId}:`, err);
  }
}

/**
 * Run a sync for a single account (initial or delta).
 * Routes to Gmail or IMAP sync based on account provider.
 */
async function syncAccountInternal(accountId: string): Promise<void> {
  try {
    const account = await getAccount(accountId);

    if (!account) {
      throw new Error("Account not found");
    }

    statusCallback?.(accountId, "syncing");

    console.log(`[syncManager] Syncing account ${accountId} (provider=${account.provider}, history_id=${account.history_id ?? "null"})`);

    if (account.provider === "caldav") {
      // CalDAV-only accounts — skip email sync, only sync calendar
      await syncCalendarForAccount(accountId);
      statusCallback?.(accountId, "done");
      return;
    }

    if (account.provider === "imap") {
      await syncImapAccount(accountId);
    } else {
      await syncGmailAccount(accountId);
    }

    // Always emit "done" when an initial sync completes (clears the bar).
    // Also emit for delta syncs that fell back to initial (recovery re-sync)
    // since those emit progress via statusCallback inside syncImapAccount.
    statusCallback?.(accountId, "done");

    // Sync calendar alongside email (non-blocking — calendar errors don't affect email sync)
    syncCalendarForAccount(accountId).catch((err) => {
      console.warn(`[syncManager] Calendar sync error for ${accountId}:`, err);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    console.error(`[syncManager] Sync failed for account ${accountId}:`, message);
    statusCallback?.(accountId, "error", undefined, message);
  }
}

async function runSync(accountIds: string[]): Promise<void> {
  if (syncPromise) {
    // Queue these accounts, merging with any already-pending IDs
    const existing = new Set(pendingAccountIds ?? []);
    for (const id of accountIds) existing.add(id);
    pendingAccountIds = [...existing];
    return syncPromise;
  }

  syncPromise = (async () => {
    try {
      for (const id of accountIds) {
        await syncAccountInternal(id);
      }
    } finally {
      syncPromise = null;
    }

    // Drain the queue — if something was queued while we were syncing, run it now
    if (pendingAccountIds) {
      const queued = pendingAccountIds;
      pendingAccountIds = null;
      await runSync(queued);
    }
  })();

  return syncPromise;
}

/**
 * Run sync for a single account, queuing if already running.
 */
export async function syncAccount(accountId: string): Promise<void> {
  return runSync([accountId]);
}

/**
 * Sync a single account NOW, bypassing the background-sync queue.
 *
 * The normal sync queue runs accounts one at a time, so a freshly-switched-to
 * account can be stuck for minutes behind a large account's initial sync. When
 * a user explicitly switches accounts we want their mailbox immediately, so
 * this runs the sync directly. Concurrent DB writes are already serialised by
 * the transaction mutex in connection.ts, so this is safe to overlap with a
 * background sync.
 */
export async function syncAccountNow(accountId: string): Promise<void> {
  return syncAccountInternal(accountId);
}

/**
 * Start the background sync timer for all accounts.
 * When `skipImmediateSync` is true the first periodic sync is deferred to the
 * next interval tick — useful when the caller already triggered a sync for a
 * newly-added account and doesn't want existing accounts to block it.
 */
export function startBackgroundSync(accountIds: string[], skipImmediateSync = false): void {
  stopBackgroundSync();

  if (!skipImmediateSync) {
    // Immediate sync
    runSync(accountIds);
  }

  // Periodic sync
  syncTimer = setInterval(() => {
    runSync(accountIds);
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop the background sync timer.
 */
export function stopBackgroundSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Trigger an immediate sync for all provided accounts.
 * Waits for completion even if a background sync is in progress.
 */
export async function triggerSync(accountIds: string[]): Promise<void> {
  await runSync(accountIds);
}

/**
 * Clear history IDs and perform a full re-sync for all provided accounts.
 * This re-downloads all threads from scratch.
 */
export async function forceFullSync(accountIds: string[]): Promise<void> {
  for (const id of accountIds) {
    await clearAccountHistoryId(id);
    // IMAP delta sync asks for UIDs above the last one seen per folder, so
    // clearing only the history id would still leave older messages
    // unreachable — lower UIDs are never requested. Dropping the folder state
    // forces a fresh SINCE/ALL search over every folder.
    await clearAllFolderSyncStates(id);
  }
  await runSync(accountIds);
}

/**
 * Delete all local data for a single account and re-sync from scratch.
 * Removes all threads, messages, history ID, and IMAP folder sync states,
 * then runs a fresh initial sync.
 */
export async function resyncAccount(accountId: string): Promise<void> {
  await deleteAllThreadsForAccount(accountId);
  await deleteAllMessagesForAccount(accountId);
  await clearAccountHistoryId(accountId);
  await clearAllFolderSyncStates(accountId);
  await runSync([accountId]);
}
