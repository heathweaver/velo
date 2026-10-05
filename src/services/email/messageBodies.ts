import { getEmailProvider } from "./providerFactory";
import {
  getMessagesForThread,
  upsertMessage,
  type DbMessage,
} from "../db/messages";
import { upsertAttachment } from "../db/attachments";
import { fillThreadSnippetIfEmpty } from "../db/threads";
import { withTransaction } from "../db/connection";
import type { ParsedMessage } from "../gmail/messageParser";

/** Bodies fetched at once when a thread opens. IMAP serialises per account in
 *  Rust anyway; for Gmail this turns N sequential round trips into N/4. */
const BODY_FETCH_CONCURRENCY = 4;

/**
 * Whether a stored message was indexed metadata-only and still needs its body.
 *
 * `null` means "never fetched". A fetched message with no text or HTML part is
 * stored with an empty body_text, so it is not fetched again on every open.
 */
export function messageNeedsBody(msg: DbMessage): boolean {
  return msg.body_cached === 0 && msg.body_html === null && msg.body_text === null;
}

/**
 * In-flight fetches by message, so a thread opened twice in quick succession
 * (or opened while the skim is reading it) costs one download, not two.
 */
const inFlight = new Map<string, Promise<void>>();

async function fetchAndStoreBody(accountId: string, msg: DbMessage): Promise<void> {
  const provider = await getEmailProvider(accountId);
  const parsed: ParsedMessage = await provider.fetchMessage(msg.id);
  const noBody = parsed.bodyHtml === null && parsed.bodyText === null;

  // Queued with every other writer. The sync engine writes through the same
  // mutex, and a write racing it from here is what used to surface as
  // "database is locked".
  await withTransaction(async () => {
    await upsertMessage({
      id: parsed.id,
      accountId,
      threadId: msg.thread_id,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      snippet: parsed.snippet || msg.snippet,
      date: parsed.date,
      isRead: parsed.isRead,
      isStarred: parsed.isStarred,
      bodyHtml: parsed.bodyHtml,
      // Mark a genuinely empty message as fetched (see messageNeedsBody).
      bodyText: noBody ? "" : parsed.bodyText,
      rawSize: parsed.rawSize,
      internalDate: parsed.internalDate,
      listUnsubscribe: parsed.listUnsubscribe,
      listUnsubscribePost: parsed.listUnsubscribePost,
      authResults: parsed.authResults,
      messageIdHeader: msg.message_id_header,
      referencesHeader: msg.references_header,
      inReplyToHeader: msg.in_reply_to_header,
      imapUid: msg.imap_uid,
      imapFolder: msg.imap_folder,
    });

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

    // Headers-only sync leaves IMAP threads without a preview line; the first
    // open is the first time there is text to show.
    if (parsed.snippet) {
      await fillThreadSnippetIfEmpty(accountId, msg.thread_id, parsed.snippet);
    }
  });
}

function loadBody(accountId: string, msg: DbMessage): Promise<void> {
  const key = `${accountId}\u0000${msg.id}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = fetchAndStoreBody(accountId, msg)
    .catch((err) => {
      console.error(`[messageBodies] Failed to load body for ${msg.id}:`, err);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/**
 * Fetch and persist full bodies for messages that were indexed metadata-only.
 * Returns refreshed rows for the thread when anything was fetched.
 */
export async function ensureMessageBodies(
  accountId: string,
  messages: DbMessage[],
): Promise<DbMessage[]> {
  const missing = messages.filter(messageNeedsBody);
  if (missing.length === 0) return messages;

  // Newest first: that is the message the reader lands on.
  const queue = [...missing].sort((a, b) => b.date - a.date);
  const workers = Array.from(
    { length: Math.min(BODY_FETCH_CONCURRENCY, queue.length) },
    async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await loadBody(accountId, next);
      }
    },
  );
  await Promise.all(workers);

  const threadId = messages[0]?.thread_id;
  if (threadId) {
    return getMessagesForThread(accountId, threadId);
  }
  return messages;
}
