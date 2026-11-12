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

## Seed file (`filing-seed.json`)

Per mailbox, optional and imported **disabled** unless `"enabled": true`, once per mailbox + sender:

```json
"transfer_rules": [
  { "sender": "boss@client.com", "dest_mailbox": "me@example.com", "dest_folder": "INBOX" }
]
```
