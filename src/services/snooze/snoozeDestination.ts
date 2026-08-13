import { getDb } from "../db/connection";
import { getAccount } from "../db/accounts";

/**
 * Where a snoozed thread is parked on the server.
 *
 * Snooze has to be a real server-side move, not a local flag. Sync rewrites a
 * thread's labels from what the server reports, so a locally-removed INBOX
 * label comes straight back on the next pass and the mail reappears — which is
 * exactly what was happening. Parking the message somewhere the server agrees
 * about is also what makes the snooze visible on your phone.
 *
 * This is how Spark does it: snoozed mail is moved into a dedicated folder
 * (its "Later" folder) so every client sees the same thing.
 */
export type SnoozeDestination =
  | { kind: "folder"; folderPath: string; labelId: string }
  | { kind: "label"; labelId: string };

/**
 * Folder names treated as an existing snooze folder, in preference order.
 *
 * "Later" comes first because that is what Spark creates, and an account that
 * has been through Spark already has snoozed mail sitting in it — reusing it
 * keeps one snooze pile rather than starting a second one.
 */
const SNOOZE_FOLDER_NAMES = ["later", "snoozed", "snooze"];

/**
 * Find where this account's snoozed mail should go, or null if there is
 * nowhere suitable.
 *
 * Deliberately does not create a folder: creating mailboxes on someone's server
 * as a side effect of clicking snooze is a bigger decision than this code
 * should make on its own. Without a destination the caller keeps the thread in
 * place rather than pretending to hide it.
 */
export async function resolveSnoozeDestination(
  accountId: string,
): Promise<SnoozeDestination | null> {
  const account = await getAccount(accountId);
  if (!account) return null;

  const db = await getDb();

  if (account.provider === "gmail_api") {
    // Gmail's own snooze is not exposed through the API, so a label stands in.
    // Removing INBOX is what actually hides it; the label is what lets the
    // thread be found again.
    const rows = await db.select<{ id: string }[]>(
      `SELECT id FROM labels
       WHERE account_id = $1 AND lower(name) IN ('snoozed', 'later', 'snooze')
       ORDER BY CASE lower(name) WHEN 'snoozed' THEN 0 WHEN 'later' THEN 1 ELSE 2 END
       LIMIT 1`,
      [accountId],
    );
    const labelId = rows[0]?.id;
    return labelId ? { kind: "label", labelId } : null;
  }

  const rows = await db.select<{ id: string; name: string; imap_folder_path: string | null }[]>(
    `SELECT id, name, imap_folder_path FROM labels
     WHERE account_id = $1 AND imap_folder_path IS NOT NULL`,
    [accountId],
  );

  for (const wanted of SNOOZE_FOLDER_NAMES) {
    const match = rows.find((r) => r.name.toLowerCase() === wanted);
    if (match?.imap_folder_path) {
      return { kind: "folder", folderPath: match.imap_folder_path, labelId: match.id };
    }
  }
  return null;
}
