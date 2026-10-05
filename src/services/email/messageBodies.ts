import { getEmailProvider } from "./providerFactory";
import {
  getMessagesForThread,
  upsertMessage,
  type DbMessage,
} from "../db/messages";
import { upsertAttachment } from "../db/attachments";

function messageNeedsBody(msg: DbMessage): boolean {
  return msg.body_cached === 0 && !msg.body_html && !msg.body_text;
}

/**
 * Fetch and persist full bodies for messages that were indexed metadata-only.
 * Returns refreshed rows for the thread when possible.
 */
export async function ensureMessageBodies(
  accountId: string,
  messages: DbMessage[],
): Promise<DbMessage[]> {
  const missing = messages.filter(messageNeedsBody);
  if (missing.length === 0) return messages;

  const provider = await getEmailProvider(accountId);

  for (const msg of missing) {
    try {
      const parsed = await provider.fetchMessage(msg.id);
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
        bodyText: parsed.bodyText,
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
    } catch (err) {
      console.error(`[messageBodies] Failed to load body for ${msg.id}:`, err);
    }
  }

  const threadId = messages[0]?.thread_id;
  if (threadId) {
    return getMessagesForThread(accountId, threadId);
  }
  return messages;
}
