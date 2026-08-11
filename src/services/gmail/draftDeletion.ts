import { deleteThread as deleteThreadFromDb } from "../db/threads";
import { getMessagesForThread } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";
import { getGmailClient } from "./tokenManager";
import { findSpecialFolder } from "../imap/messageHelper";

/**
 * Delete every draft belonging to a thread, then remove the thread locally.
 *
 * Previously this took a GmailClient and used the Drafts API, so it only ever
 * worked for Gmail accounts: on IMAP the caller's getGmailClient threw, the
 * error was swallowed, and the drafts stayed on the server.
 *
 * Gmail keeps its own draft objects, so the Drafts API is still the right tool
 * there — trashing the thread would leave the DRAFT label intact. IMAP has no
 * draft concept beyond a message in the Drafts folder, so those messages are
 * deleted by UID through the provider.
 */
export async function deleteDraftsForThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const provider = await getEmailProvider(accountId);

  if (provider.type === "gmail_api") {
    const client = await getGmailClient(accountId);
    const drafts = await client.listDrafts();
    for (const d of drafts.filter((x) => x.message.threadId === threadId)) {
      await client.deleteDraft(d.id);
    }
  } else {
    // Only touch messages that actually live in the Drafts folder. Deleting
    // every message in the thread would remove ordinary mail along with them.
    const draftsFolder = await findSpecialFolder(accountId, "\\Drafts");
    if (draftsFolder) {
      const messages = await getMessagesForThread(accountId, threadId);
      const draftMessages = messages.filter((m) =>
        m.id.includes(`-${draftsFolder}-`),
      );
      for (const msg of draftMessages) {
        await provider.deleteDraft(msg.id);
      }
    }
  }

  await deleteThreadFromDb(accountId, threadId);
}
