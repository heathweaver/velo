import { getDb } from "../db/connection";
import { getAccount } from "../db/accounts";
import { buildImapConfig } from "../imap/imapConfigBuilder";
import { imapCreateFolder } from "../imap/tauriCommands";

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
 * The folder created when an account has nowhere to park snoozed mail.
 *
 * Named to match what Spark uses, so an account that later opens Spark — or
 * that already has snoozed mail from it — sees one pile rather than two.
 */
const DEFAULT_SNOOZE_FOLDER_NAME = "Later";

/**
 * Find where this account's snoozed mail should go, creating the folder if
 * there is nowhere suitable yet.
 *
 * Returns null only when the destination could not be established at all —
 * the caller then refuses to snooze rather than hiding the thread locally and
 * letting the next sync bring it straight back.
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

  return createSnoozeFolder(accountId, rows);
}

/**
 * Create the snooze folder on the server.
 *
 * Placed under INBOX when the account's other folders live there, since a
 * server that nests everything under INBOX will usually not show a top-level
 * mailbox in the same list. The separator is taken from an existing folder
 * rather than assumed: it is "." on some servers and "/" on others, and
 * guessing wrong creates a mailbox with a literal dot in its name.
 */
async function createSnoozeFolder(
  accountId: string,
  existing: { imap_folder_path: string | null }[],
): Promise<SnoozeDestination | null> {
  const account = await getAccount(accountId);
  if (!account) return null;

  const nested = existing.find((r) => r.imap_folder_path?.startsWith("INBOX"));
  const separator = nested?.imap_folder_path?.charAt("INBOX".length) ?? null;
  const folderPath =
    separator && separator !== ""
      ? `INBOX${separator}${DEFAULT_SNOOZE_FOLDER_NAME}`
      : DEFAULT_SNOOZE_FOLDER_NAME;

  const config = buildImapConfig(account);
  await imapCreateFolder(config, folderPath);
  console.log(`[snooze] Created ${folderPath} to hold snoozed mail`);

  // The label row appears on the next sync, when the server reports the new
  // folder. Until then the path is enough to move mail into it.
  return { kind: "folder", folderPath, labelId: `folder-${folderPath}` };
}
