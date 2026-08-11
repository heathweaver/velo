import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { getDb } from "@/services/db/connection";
import { navigateToThread, getSelectedThreadId } from "@/router/navigate";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "createDraft";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "updateDraft";
      draftId: string;
      rawBase64Url: string;
      threadId?: string;
    }
  | { type: "deleteDraft"; draftId: string };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Optimistic UI helpers
// ---------------------------------------------------------------------------

function getNextThreadId(currentId: string): string | null {
  // Only auto-advance if the removed thread is the one being viewed
  const selectedId = getSelectedThreadId();
  if (selectedId !== currentId) return null;
  const { threads } = useThreadStore.getState();
  const idx = threads.findIndex((t) => t.id === currentId);
  if (idx === -1) return null;
  // Prefer next thread, fall back to previous
  const next = threads[idx + 1];
  if (next) return next.id;
  const prev = threads[idx - 1];
  if (prev) return prev.id;
  return null;
}

function applyOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "archive":
    case "trash":
    case "permanentDelete":
    case "spam":
    case "moveToFolder": {
      const nextId = getNextThreadId(action.threadId);
      store.removeThread(action.threadId);
      if (nextId) {
        navigateToThread(nextId);
      }
      break;
    }
    case "markRead":
      store.updateThread(action.threadId, { isRead: action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: action.starred });
      break;
    case "addLabel":
    case "removeLabel":
    case "sendMessage":
    case "createDraft":
    case "updateDraft":
    case "deleteDraft":
      // No universal optimistic update for these
      break;
  }
}

function revertOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "markRead":
      store.updateThread(action.threadId, { isRead: !action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: !action.starred });
      break;
    // For removes (archive/trash/spam/move), we can't easily restore the thread
    // to the list from here. The next sync will fix it.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      await db.execute(
        "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
        [action.read ? 1 : 0, accountId, action.threadId],
      );
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
          [accountId, action.threadId],
        );
      }
      break;
    case "addLabel":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  if ("draftId" in action) return action.draftId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field — it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);

  // IMAP actions operate on server-side message UIDs, but the UI often calls
  // these with an empty messageIds array (it identifies threads by id). For
  // IMAP that means "no messages to move/flag" — so the server change never
  // happens and the next sync restores the thread (e.g. "deleted mail comes
  // back"). Resolve the thread's message ids from the local DB when missing.
  const isImap = provider.type === "imap";
  if (
    isImap &&
    "messageIds" in action &&
    "threadId" in action &&
    (action.messageIds?.length ?? 0) === 0
  ) {
    const db = await getDb();
    const rows = await db.select<{ id: string }[]>(
      "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2",
      [accountId, action.threadId],
    );
    if (rows.length > 0) {
      action = { ...action, messageIds: rows.map((r) => r.id) } as EmailAction;
    }
  }

  // For IMAP moves (trash/archive/spam/move) the message leaves its folder on
  // the server and the local copy must go too, otherwise the next sync re-threads
  // it and the old label (e.g. INBOX) is re-derived. We remove the whole THREAD
  // locally (not just the message row) so sync can't leave a half-stitched
  // duplicate; sync then rebuilds it cleanly under its new folder/label.
  const removeThreadAfter =
    isImap &&
    (action.type === "trash" ||
      action.type === "archive" ||
      action.type === "spam" ||
      action.type === "moveToFolder") &&
    "threadId" in action
      ? action.threadId
      : null;

  const runCleanup = async () => {
    if (!removeThreadAfter) return;
    const db = await getDb();
    await db.execute(
      "DELETE FROM messages WHERE account_id = $1 AND thread_id = $2",
      [accountId, removeThreadAfter],
    );
    await db.execute(
      "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
      [accountId, removeThreadAfter],
    );
    await db.execute(
      "DELETE FROM threads WHERE account_id = $1 AND id = $2",
      [accountId, removeThreadAfter],
    );
    useThreadStore.getState().removeThread(removeThreadAfter);
  };

  /**
   * Run an IMAP move/trash/archive then clean up locally. If the server reports
   * the message/UID/folder is gone (a stale local copy left over from earlier
   * syncs — e.g. items stuck in All Mail that "won't delete"), treat it as
   * already-removed and still clean up locally so the action succeeds instead
   * of failing forever.
   */
  const runMove = async (op: () => Promise<unknown>): Promise<unknown> => {
    try {
      const r = await op();
      await runCleanup();
      return r;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      const alreadyGone =
        msg.includes("not found") ||
        msg.includes("does not exist") ||
        msg.includes("no matching") ||
        msg.includes("unknown mailbox") ||
        msg.includes("nonexistent");
      if (alreadyGone) {
        console.warn(
          `[emailActions] ${action.type}: message no longer on server, cleaning up locally:`,
          msg,
        );
        await runCleanup();
        return undefined;
      }
      throw err;
    }
  };

  switch (action.type) {
    case "archive":
      return runMove(() => provider.archive(action.threadId, action.messageIds));
    case "trash":
      return runMove(() => provider.trash(action.threadId, action.messageIds));
    case "spam":
      return runMove(() =>
        provider.spam(action.threadId, action.messageIds, action.isSpam),
      );
    case "moveToFolder":
      return runMove(() =>
        provider.moveToFolder(action.threadId, action.messageIds, action.folderPath),
      );
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(
        action.threadId,
        action.messageIds,
        action.read,
      );
    case "star":
      return provider.star(
        action.threadId,
        action.messageIds,
        action.starred,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage":
      return provider.sendMessage(action.rawBase64Url, action.threadId);
    case "createDraft":
      return provider.createDraft(action.rawBase64Url, action.threadId);
    case "updateDraft":
      return provider.updateDraft(
        action.draftId,
        action.rawBase64Url,
        action.threadId,
      );
    case "deleteDraft":
      return provider.deleteDraft(action.draftId);
  }
}

/** Actions that take a thread out of the current list. */
const REMOVAL_ACTIONS = new Set([
  "archive",
  "trash",
  "permanentDelete",
  "spam",
  "moveToFolder",
]);

export async function executeEmailAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  // A removal stays "in flight" until the server call settles. Without this a
  // sync completing mid-action reloads the list from a database that still has
  // the thread — or has just had it re-inserted from a server that hasn't
  // applied the move yet — so the row reappears and then vanishes again.
  const removingThreadId =
    REMOVAL_ACTIONS.has(action.type) && "threadId" in action ? action.threadId : null;
  if (removingThreadId) {
    useThreadStore.getState().beginRemoval([removingThreadId]);
  }

  try {
    return await runEmailAction(accountId, action);
  } finally {
    if (removingThreadId) {
      useThreadStore.getState().endRemoval([removingThreadId]);
    }
  }
}

async function runEmailAction(
  accountId: string,
  action: EmailAction,
): Promise<ActionResult> {
  // 1. Optimistic UI update
  applyOptimisticUpdate(action);

  // 2. Local DB update
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  // 3. If offline, queue
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(
      accountId,
      action.type,
      getResourceId(action),
      actionToParams(action),
    );
    return { success: true, queued: true };
  }

  // 4. Try online execution
  try {
    const data = await executeViaProvider(accountId, action);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);

    if (classified.isRetryable) {
      // Queue for retry
      await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
      );
      return { success: true, queued: true };
    }

    // Permanent error — revert optimistic update
    revertOptimisticUpdate(action);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  await executeViaProvider(accountId, action);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "archive",
    threadId,
    messageIds,
  });
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "trash",
    threadId,
    messageIds,
  });
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "spam",
    threadId,
    messageIds,
    isSpam,
  });
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "moveToFolder",
    threadId,
    messageIds,
    folderPath,
  });
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "addLabel",
    threadId,
    labelId,
  });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
  });

  // Notify the UI to refresh (so sent message appears in Sent folder)
  if (result.success) {
    window.dispatchEvent(new Event("velo-sync-done"));
  }

  return result;
}

export function createDraft(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "createDraft",
    rawBase64Url,
    threadId,
  });
}

export function updateDraft(
  accountId: string,
  draftId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "updateDraft",
    draftId,
    rawBase64Url,
    threadId,
  });
}

export function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, { type: "deleteDraft", draftId });
}
