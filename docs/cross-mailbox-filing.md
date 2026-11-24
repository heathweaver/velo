# Cross-mailbox filing (Apple Mail–style moves)

A mail rule can move mail from one server mailbox into a folder of **another**
mailbox, e.g. `work@` INBOX → `home@` INBOX. Like dragging a message between
accounts in Apple Mail, this is a copy-then-remove at the IMAP level:

1. `UID FETCH <uid> (UID FLAGS INTERNALDATE BODY.PEEK[])` from the source (raw bytes, unchanged).
2. Look for the `Message-ID` in the destination folder (`UID SEARCH HEADER Message-ID …`). If it's already there, skip the append (dedupe).
3. `APPEND` the exact RFC 822 bytes to the destination folder, keeping flags (`\Seen \Answered \Flagged \Draft` + keywords) and the original INTERNALDATE.
4. **Only after APPEND returns OK:** `UID STORE <uid> +FLAGS.SILENT (\Deleted)` and `UID EXPUNGE <uid>` (UIDPLUS). Without UIDPLUS the source is left flagged `\Deleted` and **never** plain-`EXPUNGE`d.

Never re-sent, never forwarded; no SMTP is involved and no filing notice is sent for `move` rules.

Each handled UID is journaled in `filing_transfers` (`appended` → `done` / `flagged`), so retries and
restarts are idempotent.

## Defining a rule (MCP)

Cross-mailbox moves are mail rules (`create_rule` / `update_rule`) with `action: "move"`, a `folder`
and a `dest_mailbox` (id or email) that the passphrase is granted:

```json
{ "mailbox": "work@example.com", "name": "Boss to home", "field": "from", "value": "boss@client.com",
  "action": "move", "folder": "INBOX", "dest_mailbox": "me@example.com" }
```

- A catch-all is `field: "from"`, `value: "@"`.
- A move into a Trash folder is refused; use the `trash` action (needs a passphrase that may delete).
- A missing destination folder is an error; nothing is created and the source stays put.

## New mail or all existing mail

Creating a rule leaves historic mail untouched. Enabled rules run on new INBOX
mail every two minutes; the first background pass records the current watermark.
All existing criteria (`from`, `to`, `subject`, case-insensitive contains) also
work with cross-mailbox moves.

To include **all existing mail**, create the rule, then call `apply_rules`:

```json
{ "mailbox": "work@example.com", "folder": "INBOX", "all_history": true }
```

This applies all enabled rules in their usual order, including flag actions and
the first matching move, to every message in that source folder. Repeat for other
source folders as needed. UIDs are snapshotted once; messages arriving afterwards
are left for the background pass. Headers and actions run in batches of 100,
without the normal 200-message cap. No new rule system or extra UI is involved.

Omit `all_history` (or set it to `false`) for the existing bounded operation:
`limit` defaults to 100 and is clamped to 1–200. `all_history: true` and `limit`
cannot be combined. The response totals `checked`, `moved`, `trashed`,
`marked_read`, and `starred` across batches.

An incomplete transfer returns an error and stops subsequent batches. Earlier
successful moves remain completed; failed APPENDs leave the source untouched.
Transfers are journaled so the same call can be retried. A source that lacks
UIDPLUS is reported as incomplete when it can only flag a source copy for deletion.

## Seed file (`filing-seed.json`)

Per mailbox, optional and imported **disabled** unless `"enabled": true`, once per mailbox + sender:

```json
"transfer_rules": [
  { "sender": "boss@client.com", "dest_mailbox": "me@example.com", "dest_folder": "INBOX" }
]
```
