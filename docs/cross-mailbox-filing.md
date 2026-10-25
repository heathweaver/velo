# Cross-mailbox filing (Apple Mail–style moves)

A filing rule can move mail from one server mailbox into a folder of **another**
mailbox, e.g. `work@` INBOX → `home@` INBOX. Like dragging a message between
accounts in Apple Mail, this is a copy-then-remove at the IMAP level:

1. `UID FETCH <uid> (UID FLAGS INTERNALDATE BODY.PEEK[])` from the source (raw bytes, unchanged).
2. Look for the `Message-ID` in the destination folder (`UID SEARCH HEADER Message-ID …`). If it's already there, skip the append (dedupe).
3. `APPEND` the exact RFC 822 bytes to the destination folder, keeping flags (`\Seen \Answered \Flagged \Draft` + keywords) and the original INTERNALDATE.
4. **Only after APPEND returns OK:** `UID STORE <uid> +FLAGS.SILENT (\Deleted)` and `UID EXPUNGE <uid>` (UIDPLUS). Without UIDPLUS the source is left flagged `\Deleted` and **never** plain-`EXPUNGE`d.

Never re-sent, never forwarded; no SMTP is involved and no filing notice is sent for `move` rules.
Folders are never created or deleted — a missing destination folder is an error and the source stays put.
Each handled UID is journaled in `filing_transfers` (`appended` → `done` / `flagged`), so retries and
restarts are idempotent.

## Defining a rule (admin API)

```http
POST /api/admin/filing-rules
{ "mailboxId": "<source id>", "senderEmail": "boss@client.com",
  "destMailbox": "me@example.com",   // id or email; omit for same mailbox
  "destFolder": "INBOX",
  "enabled": false }                 // create off, flip on after checking
```

- `action` defaults to `move` when `destMailbox`/`destFolder`/`matchAll` is given; existing
  `move_reads` rules are unchanged.
- `senderEmail` may be an address or `@domain`. Priority: exact address > `@domain` > catch-all.
- **Catch-all** (everything new in the source INBOX): `{"mailboxId": …, "matchAll": true, "destMailbox": …, "destFolder": "INBOX"}`.
  `senderEmail: "*"` is refused; `matchAll` must be explicit; catch-alls are created **disabled**
  unless `"enabled": true` is passed; one per mailbox; `move` only.
- Rejected: same-mailbox move to INBOX, `move_reads` with a destination, and A→B INBOX when B
  already moves that sender (or everything) back to A's INBOX (409, would loop).
- `PATCH /api/admin/filing-rules/:id` accepts `destMailbox` / `destFolder` (`""` clears).
- Backfill ignores catch-alls unless `?includeCatchAll=true`.

## Seed file (`filing-seed.json`)

Per mailbox, optional and imported **disabled** unless `"enabled": true`:

```json
"transfer_rules": [
  { "sender": "boss@client.com", "dest_mailbox": "me@example.com", "dest_folder": "INBOX" }
]
```

## MCP (`create_rule` / `update_rule`)

`action: "move"` accepts an optional `dest_mailbox` (id or email). It must be a mailbox the
passphrase is granted; the move then runs through the same transfer path. Catch-alls are admin-only.
