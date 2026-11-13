# Headless sync service

> **Revised scope (decision #18).** Velo is a headless mail service for agents. Reading and offline access stay with existing clients (Apple Mail, mobile apps) on the same IMAP accounts. The server already runs background pollers (`notifier.rs`, `filer.rs`, `mail_rules.rs`) and serves MCP against live IMAP, so no Rust sync engine or local mail copy is planned. Velo's web UI becomes a light client (`src/light`) that reads IMAP live through the server and keeps no copy in the browser. The sections below describe the earlier, larger plan and are kept for reference.

Status: design, not built. Governed by Meant decisions #15, #16 and #17 (velo-email stream).

## Why

Sync currently runs in the client. `src/services/gmail/syncManager.ts` and `src/services/imap/imapSync.ts` run a 60s loop in the browser or desktop app and write every message through the server's SQL gateway (`velo-server/src/db_gateway.rs`) one statement at a time. Mail only syncs while a client is open, each open client runs its own sync, and clients show "syncing" constantly.

The intended design is a dedicated container whose only job is pulling mail in and keeping it in sync. Clients read, and ask the service to act.

## Target

```
IMAP / Gmail  <->  velo-sync (container)  <-  clients (web, desktop)
                   - account + credentials      read mail, submit actions
                   - background sync            no sync loop
                   - threading, rules, queue    no admin settings
                   - admin settings + auth
                   - MCP (agents)
```

- **Owns:** accounts and credentials, the sync loop, threading, rules/filters, the offline/action queue, snooze and scheduled send, notifications, MCP.
- **Clients:** display mail and send actions (archive, star, move, send, label). They hold no credentials and run no sync.
- **Admin settings** (accounts, credentials, filters, sync options) exist only on the service behind its own admin sign-in, and are removed from client settings.

## What moves

Existing Rust in `velo-core` (IMAP client, pool, scheduler, SMTP, OAuth) and `velo-server` (mailboxes, notifier, filer, mail rules, MCP) stays. The TypeScript below moves into a new Rust sync module:

| From (`src/services`) | Lines | To |
|---|---|---|
| `imap/imapSync.ts`, `gmail/sync.ts`, `gmail/syncManager.ts` | ~2200 | sync engine (initial + delta, per account, per folder) |
| `threading/threadBuilder.ts` | ~480 | threading |
| `filters/filterEngine.ts`, smart labels | | rules (merges with `mail_rules.rs`, decision #11) |
| `emailActions.ts`, `queue/queueProcessor.ts` | ~650+ | action API + queue |
| `db/*` read queries | | read API |

## Client API

Replace the generic SQL gateway with typed endpoints: list threads (folder, label, category, search), get thread, get attachment, sync status, and actions. The SQL gateway is removed once clients stop using it, since it lets a client write anything.

## Open questions

1. MCP: same process as the sync loop, or a front process in the same container? (#15 leaves this open.)
2. Desktop app: talks to the service only, or keeps a local mode? A service-only desktop app would drop offline use.
3. Existing per-user SQLite files (`data-{userId}.db`): reuse the schema in place, or migrate to a server-owned schema.
4. Gmail: push (watch/Pub/Sub) or polling in the first version.

## Increments

1. Sync engine in Rust for IMAP, writing to the existing per-user DBs; sync status endpoint; clients stop running IMAP sync.
2. Read API; clients read from it instead of SQL gateway.
3. Action API + queue; remove `emailActions` client-side writes.
4. Gmail sync, rules, snooze/scheduled send.
5. Move admin settings and MCP fully behind the service; delete SQL gateway.
