import type { ImapConfig, ImapMessage, DeltaCheckRequest, DeltaCheckResult } from "./tauriCommands";
// Every server call in this file is background work: it is a sync walking a
// mailbox, and a user deleting a message or opening a thread must not wait
// behind it. Rust admits one operation per account at a time and lets
// interactive work jump the queue, so labelling these is what makes the
// scheduler mean anything — an unlabelled call defaults to interactive.
import {
  imapListFolders,
  imapGetFolderStatus,
  imapFetchMessages,
  imapFetchNewUids,
  imapSearchFolder,
  imapDeltaCheck,
} from "./tauriCommands";
import { buildImapConfig } from "./imapConfigBuilder";
import {
  mapFolderToLabel,
  getLabelsForMessage,
  syncFoldersToLabels,
  getSyncableFolders,
} from "./folderMapper";
import type { ParsedMessage, ParsedAttachment } from "../gmail/messageParser";
import type { SyncResult } from "../email/types";
import { upsertMessage, updateMessageThreadIds } from "../db/messages";
import { upsertThread, setThreadLabels, deleteThread } from "../db/threads";
import { repairMissingThreadLabels } from "./labelRepair";
import { needsFullRescan } from "@/services/sync/syncWindow";
import { upsertAttachment } from "../db/attachments";
import { getAccount, updateAccountSyncState } from "../db/accounts";
import { withTransaction } from "../db/connection";
import {
  upsertFolderSyncState,
  getAllFolderSyncStates,
} from "../db/folderSyncState";
import {
  buildThreads,
  type ThreadableMessage,
} from "../threading/threadBuilder";
import { getPendingOpsForResource } from "../db/pendingOperations";
import { getTransport, isTauri } from "../transport";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;
/** Number of messages to fetch per IPC call during initial sync. */
const CHUNK_SIZE = 200;
/** Number of thread groups to process per transaction in Phase 4. */
const THREAD_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Circuit breaker for connection storms
// ---------------------------------------------------------------------------

/** After this many consecutive connection failures, add a cooldown delay. */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** Delay (ms) to wait after hitting the circuit breaker threshold. */
const CIRCUIT_BREAKER_DELAY_MS = 15_000;
/** After this many consecutive failures, skip remaining folders entirely. */
const CIRCUIT_BREAKER_MAX_FAILURES = 5;
/** Delay (ms) between folder syncs during initial sync to avoid connection bursts. */
const INTER_FOLDER_DELAY_MS = 1_000;

export function isConnectionError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("tcp") ||
    msg.includes("tls") ||
    msg.includes("dns") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// IMAP SINCE date helpers
// ---------------------------------------------------------------------------

const IMAP_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Format a Date as `DD-Mon-YYYY` for the IMAP SINCE search criterion (RFC 3501 §6.4.4).
 */
export function formatImapDate(date: Date): string {
  const day = date.getUTCDate();
  const month = IMAP_MONTH_NAMES[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Compute a `DD-Mon-YYYY` SINCE date string for the given `daysBack` value.
 * Subtracts an extra day as a safety margin for timezone differences
 * (IMAP SINCE has date-only granularity, no time component).
 *
 * Returns null for a non-positive `daysBack`, meaning "no date restriction" —
 * the search then uses ALL and every message in the folder is considered.
 */
export function computeSinceDate(daysBack: number): string | null {
  if (daysBack <= 0) return null;
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysBack - 1);
  return formatImapDate(date);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ImapSyncProgress {
  phase: "folders" | "messages" | "threading" | "storing_threads" | "done";
  current: number;
  total: number;
  folder?: string;
}

export type ImapSyncProgressCallback = (progress: ImapSyncProgress) => void;

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic Message-ID for messages that lack one.
 */
function syntheticMessageId(accountId: string, folder: string, uid: number): string {
  return `synthetic-${accountId}-${folder}-${uid}@velo.local`;
}

/**
 * Convert an ImapMessage (from Tauri backend) to the ParsedMessage format
 * used throughout the app.
 */
export function imapMessageToParsedMessage(
  msg: ImapMessage,
  accountId: string,
  folderLabelId: string,
): { parsed: ParsedMessage; threadable: ThreadableMessage } {
  const messageId = `imap-${accountId}-${msg.folder}-${msg.uid}`;
  const rfc2822MessageId =
    msg.message_id ?? syntheticMessageId(accountId, msg.folder, msg.uid);

  const folderMapping = { labelId: folderLabelId, labelName: "", type: "" };
  const labelIds = getLabelsForMessage(
    folderMapping,
    msg.is_read,
    msg.is_starred,
    msg.is_draft,
  );

  const snippet = msg.snippet ?? (msg.body_text ? msg.body_text.slice(0, 200) : "");

  const attachments: ParsedAttachment[] = msg.attachments.map((att) => ({
    filename: att.filename,
    mimeType: att.mime_type,
    size: att.size,
    gmailAttachmentId: att.part_id, // reuse field for IMAP part ID
    contentId: att.content_id,
    isInline: att.is_inline,
  }));

  const parsed: ParsedMessage = {
    id: messageId,
    threadId: "", // will be assigned after threading
    fromAddress: msg.from_address,
    fromName: msg.from_name,
    toAddresses: msg.to_addresses,
    ccAddresses: msg.cc_addresses,
    bccAddresses: msg.bcc_addresses,
    replyTo: msg.reply_to,
    subject: msg.subject,
    snippet,
    date: msg.date * 1000,
    isRead: msg.is_read,
    isStarred: msg.is_starred,
    bodyHtml: msg.body_html,
    bodyText: msg.body_text,
    rawSize: msg.raw_size,
    internalDate: msg.date * 1000,
    labelIds,
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: msg.list_unsubscribe,
    listUnsubscribePost: msg.list_unsubscribe_post,
    authResults: msg.auth_results,
  };

  const threadable: ThreadableMessage = {
    id: messageId,
    messageId: rfc2822MessageId,
    inReplyTo: msg.in_reply_to,
    references: msg.references,
    subject: msg.subject,
    date: msg.date * 1000,
  };

  return { parsed, threadable };
}

// ---------------------------------------------------------------------------
// Thread storage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fetch messages from a folder in batches
// ---------------------------------------------------------------------------



/**
 * What threading needs to know about a message once its body is on disk.
 *
 * Threading only reads headers and flags, so nothing larger is worth holding:
 * a mailbox sync that kept whole messages in memory until the end held two
 * copies of every body — the parsed one and the raw IMAP one — for the length
 * of the run.
 */
interface MessageMeta {
  id: string;
  rfcMessageId: string;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  subject: string | null;
  snippet: string;
  date: number;
}


/**
 * Set when the Rust storage command has failed once, so the rest of the session
 * takes the row-by-row path without retrying it per chunk.
 */
let rustStoreUnavailable = false;

/**
 * Shape a parsed message for the Rust storage command.
 *
 * Field names are what serde expects on the other side; the placeholder thread
 * is derived there from the message itself, so it is not sent separately.
 */
function toStoredMessage(accountId: string, parsed: ParsedMessage, msg: ImapMessage) {
  return {
    id: parsed.id,
    accountId,
    threadId: parsed.id,
    fromAddress: parsed.fromAddress,
    fromName: parsed.fromName,
    toAddresses: parsed.toAddresses,
    ccAddresses: parsed.ccAddresses,
    bccAddresses: parsed.bccAddresses,
    replyTo: parsed.replyTo,
    subject: parsed.subject,
    snippet: parsed.snippet,
    date: parsed.date,
    isRead: parsed.isRead,
    isStarred: parsed.isStarred,
    hasAttachments: parsed.hasAttachments,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    rawSize: parsed.rawSize,
    internalDate: parsed.internalDate,
    listUnsubscribe: parsed.listUnsubscribe ?? null,
    listUnsubscribePost: parsed.listUnsubscribePost ?? null,
    authResults: parsed.authResults ?? null,
    messageIdHeader: msg.message_id ?? null,
    referencesHeader: msg.references ?? null,
    inReplyToHeader: msg.in_reply_to ?? null,
    imapUid: msg.uid ?? null,
    imapFolder: msg.folder ?? null,
    attachments: parsed.attachments.map((att) => ({
      id: `${parsed.id}_${att.gmailAttachmentId}`,
      messageId: parsed.id,
      accountId,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      gmailAttachmentId: att.gmailAttachmentId,
      contentId: att.contentId,
      isInline: att.isInline,
    })),
  };
}

/**
 * Write one fetched chunk to disk and keep only what threading needs.
 *
 * Each message lands under a placeholder thread of its own — threading has not
 * happened yet, and the foreign key demands a thread exists. materialiseThreads
 * re-parents them afterwards.
 */
async function storeChunk(
  accountId: string,
  chunkParsed: { parsed: ParsedMessage; msg: ImapMessage; threadable: ThreadableMessage }[],
  allMeta: Map<string, MessageMeta>,
  allThreadable: ThreadableMessage[],
  labelsByRfcId: Map<string, Set<string>>,
): Promise<void> {
  if (chunkParsed.length > 0) {
    // Serialised against every other writer, but no BEGIN is issued here — see
    // withTransaction. On the desktop the whole chunk goes to Rust as one call,
    // which does wrap it in a real transaction; the web path still writes row by
    // row through the SQL gateway.
    await withTransaction(async () => {
      if (isTauri() && !rustStoreUnavailable) {
        try {
          await getTransport().invoke("db_store_chunk", {
            messages: chunkParsed.map(({ parsed, msg }) => toStoredMessage(accountId, parsed, msg)),
          });
          return;
        } catch (err) {
          // Falling back rather than failing the sync: this path is newer than
          // the one below it, and a sync that stores nothing is a worse outcome
          // than a slow one. Latched for the session so the failure is reported
          // once instead of per chunk.
          rustStoreUnavailable = true;
          console.error(
            "[imapSync] Rust chunk storage failed — falling back to row-by-row writes for this session:",
            err,
          );
        }
      }

      for (const { parsed, msg } of chunkParsed) {
        // Create placeholder thread first to satisfy FK constraint
        await upsertThread({
          id: parsed.id,
          accountId,
          subject: parsed.subject,
          snippet: parsed.snippet,
          lastMessageAt: parsed.date,
          messageCount: 1,
          isRead: parsed.isRead,
          isStarred: parsed.isStarred,
          isImportant: false,
          hasAttachments: parsed.hasAttachments,
        });
        await upsertMessage({
          id: parsed.id,
          accountId,
          threadId: parsed.id,
          fromAddress: parsed.fromAddress,
          fromName: parsed.fromName,
          toAddresses: parsed.toAddresses,
          ccAddresses: parsed.ccAddresses,
          bccAddresses: parsed.bccAddresses,
          replyTo: parsed.replyTo,
          subject: parsed.subject,
          snippet: parsed.snippet,
          date: parsed.date,
          isRead: parsed.isRead,
          isStarred: parsed.isStarred,
          bodyHtml: parsed.bodyHtml,
          bodyText: parsed.bodyText,
          rawSize: parsed.rawSize,
          internalDate: parsed.internalDate,
          listUnsubscribe: parsed.listUnsubscribe,
          listUnsubscribePost: parsed.listUnsubscribePost,
          authResults: parsed.authResults,
          messageIdHeader: msg.message_id ?? null,
          referencesHeader: msg.references ?? null,
          inReplyToHeader: msg.in_reply_to ?? null,
          imapUid: msg.uid ?? null,
          imapFolder: msg.folder ?? null,
        });

        // Store attachments
        for (const att of parsed.attachments) {
          await upsertAttachment({
            id: `${parsed.id}_${att.gmailAttachmentId}`,
            messageId: parsed.id,
            accountId,
            filename: att.filename,
            mimeType: att.mimeType,
            size: att.size,
            gmailAttachmentId: att.gmailAttachmentId,
            contentId: att.contentId,
            isInline: att.isInline,
          });
        }
      }
    });
  }

  // Keep only lightweight data in memory for threading
  for (const { parsed, threadable } of chunkParsed) {
    const meta: MessageMeta = {
      id: parsed.id,
      rfcMessageId: threadable.messageId,
      labelIds: parsed.labelIds,
      isRead: parsed.isRead,
      isStarred: parsed.isStarred,
      hasAttachments: parsed.hasAttachments,
      subject: parsed.subject,
      snippet: parsed.snippet,
      date: parsed.date,
    };
    allMeta.set(parsed.id, meta);
    allThreadable.push(threadable);

    // Build cross-folder label map
    let labels = labelsByRfcId.get(threadable.messageId);
    if (!labels) {
      labels = new Set();
      labelsByRfcId.set(threadable.messageId, labels);
    }
    for (const lid of parsed.labelIds) {
      labels.add(lid);
    }
  }
}

/**
 * Thread the messages already on disk, write the thread records, and drop the
 * placeholders left behind.
 *
 * Split out so delta sync runs the same phases as the initial one rather than
 * its own variant that held every message in memory to do it.
 */
async function materialiseThreads(
  accountId: string,
  allThreadable: ThreadableMessage[],
  allMeta: Map<string, MessageMeta>,
  labelsByRfcId: Map<string, Set<string>>,
  onProgress?: (progress: ImapSyncProgress) => void,
): Promise<number> {
  onProgress?.({ phase: "threading", current: 0, total: allThreadable.length });
  const threadGroups = buildThreads(allThreadable);
  console.log(
    `[imapSync] Threading: ${allThreadable.length} messages → ${threadGroups.length} thread groups`,
  );

  // ---------------------------------------------------------------------------
  // Phase 4: Create thread records + batch-update message thread IDs
  // ---------------------------------------------------------------------------
  onProgress?.({ phase: "storing_threads", current: 0, total: threadGroups.length });

  // Messages actually moved out of their placeholder thread. Only these are
  // safe to clean up in phase 5: messages cascade-delete with their thread, so
  // dropping the placeholder of a message still parented to it destroys the
  // mail.
  const reparentedMessageIds = new Set<string>();

  for (let batchStart = 0; batchStart < threadGroups.length; batchStart += THREAD_BATCH_SIZE) {
    const batch = threadGroups.slice(batchStart, batchStart + THREAD_BATCH_SIZE);

    // Pre-check pending ops OUTSIDE the transaction to avoid nested DB issues
    const skippedThreadIds = new Set<string>();
    for (const group of batch) {
      const pendingOps = await getPendingOpsForResource(accountId, group.threadId);
      if (pendingOps.length > 0) {
        console.log(`[imapSync] Skipping thread ${group.threadId}: has ${pendingOps.length} pending local ops`);
        skippedThreadIds.add(group.threadId);
      }
    }

    await withTransaction(async () => {
      for (const group of batch) {
        if (skippedThreadIds.has(group.threadId)) continue;

        const messages = group.messageIds
          .map((id) => allMeta.get(id))
          .filter((m): m is MessageMeta => m !== undefined);

        if (messages.length === 0) continue;

        // Sort by date ascending
        messages.sort((a, b) => a.date - b.date);

        const firstMessage = messages[0]!;
        const lastMessage = messages[messages.length - 1]!;

        // Collect all label IDs including cross-folder copies
        const allLabelIds = new Set<string>();
        for (const msg of messages) {
          for (const lid of msg.labelIds) {
            allLabelIds.add(lid);
          }
          const extraLabels = labelsByRfcId.get(msg.rfcMessageId);
          if (extraLabels) {
            for (const lid of extraLabels) {
              allLabelIds.add(lid);
            }
          }
        }

        const isRead = messages.every((m) => m.isRead);
        const isStarred = messages.some((m) => m.isStarred);
        const hasAttachments = messages.some((m) => m.hasAttachments);

        await upsertThread({
          id: group.threadId,
          accountId,
          subject: firstMessage.subject,
          snippet: lastMessage.snippet,
          lastMessageAt: lastMessage.date,
          messageCount: messages.length,
          isRead,
          isStarred,
          isImportant: false,
          hasAttachments,
        });

        await setThreadLabels(accountId, group.threadId, [...allLabelIds]);

        // Batch-update thread IDs for all messages in this thread
        const messageIds = messages.map((m) => m.id);
        await updateMessageThreadIds(accountId, messageIds, group.threadId);
        for (const id of messageIds) reparentedMessageIds.add(id);
      }
    });

    onProgress?.({
      phase: "storing_threads",
      current: Math.min(batchStart + THREAD_BATCH_SIZE, threadGroups.length),
      total: threadGroups.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 5: Clean up orphaned placeholder threads
  // ---------------------------------------------------------------------------
  // Phase 2 created a placeholder thread per message (threadId = messageId).
  // Phase 4 merged messages into real threads and updated message thread IDs.
  // Placeholder threads that are no longer referenced by any final thread group
  // should be deleted to avoid ghost threads in the UI.
  const finalThreadIds = new Set(threadGroups.map((g) => g.threadId));
  let orphanCount = 0;
  for (const msgId of reparentedMessageIds) {
    // If this message's placeholder ID isn't a final thread ID, it's orphaned.
    // Messages skipped for pending local ops are absent from this set: they are
    // still parented to their placeholder, and deleting it would take the
    // message with it.
    if (!finalThreadIds.has(msgId)) {
      await deleteThread(accountId, msgId);
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    console.log(`[imapSync] Cleaned up ${orphanCount} orphaned placeholder threads`);
  }

  return threadGroups.length;
}


/**
 * Fetch a folder's UIDs and write each batch to disk as it arrives.
 *
 * The alternative — fetch everything, then store — is what delta sync used to
 * do, and it held every message body of every folder in memory until the run
 * finished.
 */
async function fetchAndStoreUids(
  accountId: string,
  config: ImapConfig,
  folderPath: string,
  uids: number[],
  labelId: string,
  allMeta: Map<string, MessageMeta>,
  allThreadable: ThreadableMessage[],
  labelsByRfcId: Map<string, Set<string>>,
): Promise<{ lastUid: number; uidvalidity: number; stored: number }> {
  let lastUid = 0;
  let uidvalidity = 0;
  let stored = 0;

  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const result = await imapFetchMessages(config, folderPath, batch, "background");
    uidvalidity = result.folder_status.uidvalidity;

    const chunkParsed: { parsed: ParsedMessage; msg: ImapMessage; threadable: ThreadableMessage }[] = [];
    for (const msg of result.messages) {
      if (msg.uid > lastUid) lastUid = msg.uid;
      const { parsed, threadable } = imapMessageToParsedMessage(msg, accountId, labelId);
      parsed.threadId = parsed.id; // placeholder — materialiseThreads re-parents
      chunkParsed.push({ parsed, msg, threadable });
    }

    await storeChunk(accountId, chunkParsed, allMeta, allThreadable, labelsByRfcId);
    stored += chunkParsed.length;
  }

  return { lastUid, uidvalidity, stored };
}

// ---------------------------------------------------------------------------
// Initial sync
// ---------------------------------------------------------------------------

/**
 * Perform initial sync for an IMAP account.
 * Fetches messages from all folders for the past N days.
 */
export async function imapInitialSync(
  accountId: string,
  daysBack = 365,
  onProgress?: ImapSyncProgressCallback,
): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  // Phase 1: List and sync folders
  onProgress?.({ phase: "folders", current: 0, total: 1 });
  const allFolders = await imapListFolders(config, "background");
  const syncableFolders = getSyncableFolders(allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);
  console.log(`[imapSync] Initial sync for account ${accountId}: ${syncableFolders.length} syncable folders`);
  onProgress?.({ phase: "folders", current: 1, total: 1 });

  // ---------------------------------------------------------------------------
  // Phase 2: Streaming fetch & store
  // ---------------------------------------------------------------------------
  // For each folder, for each batch: fetch → parse → store to DB immediately
  // (with placeholder threadId = messageId). Only lightweight metadata is kept
  // in memory for the subsequent threading pass.
  // This avoids accumulating all message bodies in memory (OOM on large mailboxes).

  const allThreadable: ThreadableMessage[] = [];
  const allMeta = new Map<string, MessageMeta>();

  // Track RFC Message-ID → all label IDs from every folder copy.
  // This ensures labels aren't lost when the threading algorithm deduplicates
  // messages that exist in multiple IMAP folders (e.g., INBOX + Sent).
  const labelsByRfcId = new Map<string, Set<string>>();

  await repairMissingThreadLabels(accountId, syncableFolders);

  // Estimate total messages for progress
  let totalEstimate = 0;
  for (const folder of syncableFolders) {
    totalEstimate += folder.exists;
  }

  let fetchedTotal = 0;
  let totalMessagesFound = 0;
  let storedCount = 0;
  let consecutiveFailures = 0;
  const folderErrors: string[] = [];

  for (let folderIdx = 0; folderIdx < syncableFolders.length; folderIdx++) {
    const folder = syncableFolders[folderIdx]!;
    if (folder.exists === 0) continue;

    // Circuit breaker: skip remaining folders after too many consecutive failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive connection failures, ` +
        `skipping remaining ${syncableFolders.length - folderIdx} folders`,
      );
      break;
    }

    // Circuit breaker: add cooldown delay after threshold failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(
        `[imapSync] Circuit breaker: ${consecutiveFailures} consecutive failures, ` +
        `waiting ${CIRCUIT_BREAKER_DELAY_MS / 1000}s before next folder`,
      );
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    // Inter-folder delay to avoid connection bursts (skip before first folder)
    if (folderIdx > 0) {
      await delay(INTER_FOLDER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);

    try {
      // Phase 2a: Lightweight search — get UIDs only (no message bodies over IPC)
      const sinceDate = computeSinceDate(daysBack);
      const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate, "background");
      const uidsToFetch = searchResult.uids;

      // Reset circuit breaker on success
      consecutiveFailures = 0;

      if (uidsToFetch.length === 0) continue;

      // Date filter config
      // Negative infinity when syncing everything, so nothing is filtered out.
      const cutoffDate =
        daysBack <= 0
          ? Number.NEGATIVE_INFINITY
          : Math.floor(Date.now() / 1000) - daysBack * 86400;
      const nowSeconds = Math.floor(Date.now() / 1000);
      let dateFallbackCount = 0;
      let folderFetchedCount = 0;
      let folderStoredCount = 0;
      let lastUid = 0;
      const uidvalidity = searchResult.folder_status.uidvalidity;

      // Phase 2b: Fetch messages in small IPC-friendly chunks
      for (let chunkStart = 0; chunkStart < uidsToFetch.length; chunkStart += CHUNK_SIZE) {
        const chunkUids = uidsToFetch.slice(chunkStart, chunkStart + CHUNK_SIZE);
        let chunkResult;
        try {
          chunkResult = await imapFetchMessages(config, folder.raw_path, chunkUids, "background");
        } catch (chunkErr) {
          // Retry once for transient connection errors
          if (isConnectionError(chunkErr)) {
            console.warn(`[imapSync] Chunk fetch failed in ${folder.path}, retrying in 2s:`, chunkErr);
            await delay(2_000);
            try {
              chunkResult = await imapFetchMessages(config, folder.raw_path, chunkUids, "background");
            } catch (retryErr) {
              console.error(`[imapSync] Chunk retry failed in ${folder.path}:`, retryErr);
              continue;
            }
          } else {
            console.error(`[imapSync] Failed to fetch chunk ${chunkStart}-${chunkStart + chunkUids.length} in ${folder.path}:`, chunkErr);
            continue;
          }
        }

        // Collect parsed data for this chunk to write in a single transaction
        const chunkParsed: { parsed: ParsedMessage; msg: ImapMessage; threadable: ThreadableMessage }[] = [];

        for (const msg of chunkResult.messages) {
          if (msg.uid > lastUid) lastUid = msg.uid;
          folderFetchedCount++;

          // Date filter
          if (msg.date === 0) {
            dateFallbackCount++;
            msg.date = nowSeconds;
          }
          if (msg.date < cutoffDate) continue;

          const { parsed, threadable } = imapMessageToParsedMessage(
            msg,
            accountId,
            folderMapping.labelId,
          );

          parsed.threadId = parsed.id; // placeholder — updated after threading
          chunkParsed.push({ parsed, msg, threadable });
        }

        await storeChunk(accountId, chunkParsed, allMeta, allThreadable, labelsByRfcId);

        folderStoredCount += chunkParsed.length;
        storedCount += chunkParsed.length;

        // Report progress after each chunk (not just each folder)
        onProgress?.({
          phase: "messages",
          current: fetchedTotal + Math.min(chunkStart + CHUNK_SIZE, uidsToFetch.length),
          total: totalEstimate,
          folder: folder.path,
        });
      }

      totalMessagesFound += folderFetchedCount;
      fetchedTotal += uidsToFetch.length;

      if (dateFallbackCount > 0) {
        console.warn(
          `[imapSync] Folder ${folder.path}: ${dateFallbackCount}/${folderFetchedCount} messages had unparseable dates, using current time as fallback`,
        );
      }

      console.log(
        `[imapSync] Folder ${folder.path}: ${uidsToFetch.length} UIDs, ${folderFetchedCount} fetched, ${folderStoredCount} after date filter`,
      );

      // Update folder sync state
      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
        window_days: daysBack,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`[imapSync] Failed to sync folder ${folder.path}:`, err);
      folderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
      // Continue with next folder
    }
  }

  // If no messages were stored and every folder failed, propagate the error
  if (storedCount === 0 && folderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${folderErrors[0]}`);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Thread messages (lightweight — only IDs + headers in memory)
  // ---------------------------------------------------------------------------
  const threadCount = await materialiseThreads(
    accountId,
    allThreadable,
    allMeta,
    labelsByRfcId,
    onProgress,
  );

  console.log(
    `[imapSync] Stored ${storedCount} messages in ${threadCount} threads (found ${totalMessagesFound} on server)`,
  );

  // Only mark sync as complete if messages were stored OR no messages exist on server.
  if (storedCount > 0 || totalMessagesFound === 0) {
    await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);
  } else {
    console.warn(
      `[imapSync] Found ${totalMessagesFound} messages on server but stored 0 — NOT marking sync as complete so it will be retried`,
    );
  }

  onProgress?.({
    phase: "done",
    current: storedCount,
    total: storedCount,
  });

  return { messages: [] };
}

// ---------------------------------------------------------------------------
// Delta sync
// ---------------------------------------------------------------------------

/**
 * Perform delta sync for an IMAP account.
 * Fetches only new messages since the last sync using stored UID state.
 */

export async function imapDeltaSync(accountId: string, daysBack = 365): Promise<SyncResult> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  const config = buildImapConfig(account);

  // Get all folders we've synced before
  const syncStates = await getAllFolderSyncStates(accountId);

  // Also check for any new folders
  const allFolders = await imapListFolders(config, "background");
  const syncableFolders = getSyncableFolders(allFolders);
  await syncFoldersToLabels(accountId, syncableFolders);

  // Before deciding what to fetch, put back any labels an interrupted run
  // failed to write — otherwise that mail stays stored but invisible, and no
  // amount of syncing brings it back because it is never re-fetched.
  await repairMissingThreadLabels(accountId, syncableFolders);

  const syncStateMap = new Map(syncStates.map((s) => [s.folder_path, s]));

  const allThreadable: ThreadableMessage[] = [];
  const allMeta = new Map<string, MessageMeta>();
  const labelsByRfcId = new Map<string, Set<string>>();
  let storedCount = 0;

  // Separate folders into new (no saved state) vs existing (have saved state)
  // A folder whose window has widened is walked from scratch rather than
  // asked for new UIDs: the mail it is missing is older than its high-water
  // mark, so a delta check would report nothing to do and the gap would
  // persist for good.
  const rescanFolders = syncableFolders.filter((f) => {
    const state = syncStateMap.get(f.raw_path);
    return state !== undefined && needsFullRescan(state.window_days, daysBack);
  });
  if (rescanFolders.length > 0) {
    console.log(
      `[imapSync] Sync window widened — rescanning ${rescanFolders.length} folder(s) from the start`,
    );
  }
  const rescanPaths = new Set(rescanFolders.map((f) => f.raw_path));

  const newFolders = syncableFolders.filter(
    (f) => !syncStateMap.has(f.raw_path) || rescanPaths.has(f.raw_path),
  );
  const existingFolders = syncableFolders.filter(
    (f) => syncStateMap.has(f.raw_path) && !rescanPaths.has(f.raw_path),
  );

  // Handle new folders: search for UIDs then fetch in chunks
  let consecutiveFailures = 0;
  const deltaFolderErrors: string[] = [];
  for (const folder of newFolders) {
    // Circuit breaker: skip remaining new folders after too many failures
    if (consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      console.warn(
        `[imapSync] Delta sync circuit breaker: ${consecutiveFailures} consecutive failures, skipping remaining new folders`,
      );
      break;
    }
    if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      await delay(CIRCUIT_BREAKER_DELAY_MS);
    }

    const folderMapping = mapFolderToLabel(folder);
    try {
      const sinceDate = computeSinceDate(daysBack);
      const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate, "background");
      consecutiveFailures = 0;

      if (searchResult.uids.length === 0) continue;

      const { lastUid, stored } = await fetchAndStoreUids(
        accountId,
        config,
        folder.raw_path,
        searchResult.uids,
        folderMapping.labelId,
        allMeta,
        allThreadable,
        labelsByRfcId,
      );
      storedCount += stored;

      await upsertFolderSyncState({
        account_id: accountId,
        folder_path: folder.raw_path,
        uidvalidity: searchResult.folder_status.uidvalidity,
        last_uid: lastUid,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
        window_days: daysBack,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
      console.error(`Delta sync failed for new folder ${folder.path}:`, err);
      deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      if (isConnectionError(err)) {
        consecutiveFailures++;
      }
    }
  }

  // Batch-check existing folders in a single IMAP connection.
  // Falls back to per-folder checks if the batch command fails.
  if (existingFolders.length > 0) {
    const deltaRequests: DeltaCheckRequest[] = existingFolders.map((folder) => {
      const savedState = syncStateMap.get(folder.raw_path)!;
      return {
        folder: folder.raw_path,
        last_uid: savedState.last_uid,
        uidvalidity: savedState.uidvalidity ?? 0,
      };
    });

    let deltaResultMap: Map<string, DeltaCheckResult>;
    try {
      const deltaResults = await imapDeltaCheck(config, deltaRequests, "background");
      deltaResultMap = new Map(deltaResults.map((r) => [r.folder, r]));
      console.log(`[imapSync] Batch delta check: ${deltaResults.length}/${existingFolders.length} folders checked`);
    } catch (err) {
      // Batch check failed — fall back to per-folder checks
      console.warn(`[imapSync] Batch delta check failed, falling back to per-folder:`, err);
      deltaResultMap = new Map();
      for (const folder of existingFolders) {
        const savedState = syncStateMap.get(folder.raw_path)!;
        try {
          const currentStatus = await imapGetFolderStatus(config, folder.raw_path, "background");
          const uidvalidityChanged =
            savedState.uidvalidity !== null &&
            currentStatus.uidvalidity !== savedState.uidvalidity;

          if (uidvalidityChanged) {
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: [],
              uidvalidity_changed: true,
            });
          } else {
            const newUids = await imapFetchNewUids(config, folder.raw_path, savedState.last_uid, "background");
            deltaResultMap.set(folder.raw_path, {
              folder: folder.raw_path,
              uidvalidity: currentStatus.uidvalidity,
              new_uids: newUids,
              uidvalidity_changed: false,
            });
          }
        } catch (folderErr) {
          console.error(`[imapSync] Per-folder check failed for ${folder.path}:`, folderErr);
        }
      }
    }

    for (const folder of existingFolders) {
      const folderMapping = mapFolderToLabel(folder);
      const savedState = syncStateMap.get(folder.raw_path)!;
      const deltaResult = deltaResultMap.get(folder.raw_path);

      if (!deltaResult) continue;

      try {
        if (deltaResult.uidvalidity_changed) {
          // UIDVALIDITY changed — full resync of this folder
          console.warn(
            `UIDVALIDITY changed for folder ${folder.path} ` +
              `(was ${savedState.uidvalidity}, now ${deltaResult.uidvalidity}). ` +
              `Doing full resync of this folder.`,
          );
          const sinceDate = computeSinceDate(daysBack);
          const searchResult = await imapSearchFolder(config, folder.raw_path, sinceDate, "background");
          if (searchResult.uids.length === 0) continue;

          const { lastUid, stored } = await fetchAndStoreUids(
            accountId,
            config,
            folder.raw_path,
            searchResult.uids,
            folderMapping.labelId,
            allMeta,
            allThreadable,
            labelsByRfcId,
          );
          storedCount += stored;

          await upsertFolderSyncState({
            account_id: accountId,
            folder_path: folder.raw_path,
            uidvalidity: searchResult.folder_status.uidvalidity,
            last_uid: lastUid,
            modseq: null,
            last_sync_at: Math.floor(Date.now() / 1000),
            window_days: daysBack,
          });
          continue;
        }

        // Normal delta: fetch the new UIDs returned by delta check
        if (deltaResult.new_uids.length === 0) continue;

        const { lastUid, uidvalidity, stored } = await fetchAndStoreUids(
          accountId,
          config,
          folder.raw_path,
          deltaResult.new_uids,
          folderMapping.labelId,
          allMeta,
          allThreadable,
          labelsByRfcId,
        );
        storedCount += stored;

        await upsertFolderSyncState({
          account_id: accountId,
          folder_path: folder.raw_path,
          uidvalidity,
          last_uid: Math.max(savedState.last_uid, lastUid),
          modseq: null,
          last_sync_at: Math.floor(Date.now() / 1000),
          window_days: daysBack,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
        console.error(`Delta sync failed for folder ${folder.path}:`, err);
        deltaFolderErrors.push(`${folder.path}: ${errMsg}`);
      }
    }
  }

  // If no new messages found and every folder errored, propagate the error
  if (storedCount === 0 && deltaFolderErrors.length > 0) {
    throw new Error(`All folders failed to sync: ${deltaFolderErrors[0]}`);
  }

  if (storedCount === 0) {
    return { messages: [], storedCount: 0 };
  }

  await materialiseThreads(accountId, allThreadable, allMeta, labelsByRfcId);

  // Update sync state timestamp
  await updateAccountSyncState(accountId, `imap-synced-${Date.now()}`);

  // Bodies are already on disk, so there is nothing to hand back but the count.
  return { messages: [], storedCount };
}
