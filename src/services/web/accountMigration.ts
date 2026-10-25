/**
 * Web-only: move IMAP accounts that were added in this browser onto the server.
 *
 * Accounts added through "Add account" keep their password encrypted in the
 * browser, so the server (and any agent it serves) can't use them. This hands
 * each one to the server as a provisioned mailbox, using the password the
 * browser can decrypt. `syncProvisionedMailboxes` then replaces the local copy
 * with the server-backed account (same email), so nothing is duplicated.
 *
 * Provisioning mailboxes is an admin action; for anyone else this does nothing
 * and their accounts stay as they were.
 */

import { getAllAccounts } from "../db/accounts";
import { mapSecurity } from "../imap/imapConfigBuilder";
import {
  createMailbox,
  fetchMe,
  listAllMailboxes,
} from "../auth/authService";

/** Returns the emails that were uploaded to the server. */
export async function migrateBrowserAccountsToServer(): Promise<string[]> {
  const me = await fetchMe();
  if (!me || me.role !== "admin") return [];

  const onServer = new Set(
    (await listAllMailboxes()).map((m) => m.email.toLowerCase()),
  );

  const moved: string[] = [];
  for (const a of await getAllAccounts()) {
    if (a.mailbox_id) continue;
    if (a.provider !== "imap" || a.auth_method !== "password") continue;
    if (!a.imap_host || !a.smtp_host || !a.imap_password) continue;
    if (onServer.has(a.email.toLowerCase())) continue;

    try {
      await createMailbox({
        ownerUserId: me.id,
        email: a.email,
        displayName: a.display_name ?? undefined,
        imapHost: a.imap_host,
        imapPort: a.imap_port ?? 993,
        imapSecurity: mapSecurity(a.imap_security),
        smtpHost: a.smtp_host,
        smtpPort: a.smtp_port ?? 465,
        smtpSecurity: mapSecurity(a.smtp_security),
        username: a.imap_username ?? undefined,
        password: a.imap_password,
        acceptInvalidCerts: a.accept_invalid_certs === 1,
      });
      moved.push(a.email);
    } catch (err) {
      // Leave the local account alone; it keeps working in this browser.
      console.error(`Could not move ${a.email} to the server:`, err);
    }
  }
  return moved;
}
