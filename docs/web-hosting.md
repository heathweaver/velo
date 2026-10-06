# Hosting Velo on your own server (web version)

The web version is a single Rust binary (`velo-server`) that serves both the
built frontend and the JSON API the browser talks to. Everything is stored in
one SQLite file — no separate database service.

> **Status:** Phase 2. The email transport, SQL gateway, web build, and static
> serving all work end-to-end. Per-user login/roles and the web OAuth redirect
> are Phase 3 — until then, treat a deployment as trusted/single-user and keep
> it behind your own access control (VPN, basic-auth proxy, etc.).

## 1. Build the two artifacts

On a build machine with Node + Rust:

```bash
# Frontend (produces ./dist — static files)
npm install
npm run build:web

# Server binary (produces ./src-tauri/target/release/velo-server)
cd src-tauri
cargo build -p velo-server --release
```

## 2. Upload to your server

Copy these to the server (anywhere, e.g. `/opt/velo`):

- `dist/`  → the built frontend
- `src-tauri/target/release/velo-server` → the binary

## 3. Run it

See **First run** below for the full command with admin bootstrap. Environment
variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `VELO_BIND` | `127.0.0.1:8080` | Address/port to listen on |
| `VELO_CONTROL_DB` | `velo-control.db` | Server-only DB: users, sessions, mailboxes, profiles |
| `VELO_DATA_DIR` | `data` | Directory holding per-user mailbox DBs (`data-{userId}.db`) |
| `VELO_STATIC_DIR` | _(unset)_ | Directory of the built frontend; when set, the SPA is served with deep-link fallback |
| `VELO_ADMIN_EMAIL` | _(unset)_ | First run only: creates the admin user |
| `VELO_ADMIN_PASSWORD` | _(unset)_ | First run only: admin password |
| `VELO_SECRET_KEY` | _(generated)_ | base64 32-byte key for encrypting stored mailbox passwords; if unset, a `velo-secret.key` file is generated in `VELO_DATA_DIR` |
| `VELO_PUBLIC_URL` | _(empty)_ | Public base URL used in new-mail notification links (e.g. `https://mail.example.com`) |
| `VELO_NOTIFY` | _(on)_ | Set to `0` to disable new-mail email notifications |
| `VELO_NOTIFY_INTERVAL` | `120` | Seconds between new-mail polls |
| `VELO_FILER` | _(off)_ | Set to `1` to enable the server-side Reads filer (MOVE matching newsletters to `Reads`) |
| `VELO_FILER_INTERVAL` | `120` | Seconds between filer polls (min 10) |
| `VELO_FILER_NOTIFY_DELAY` | `5` | Seconds between the "filing" notification and the MOVE |
| `VITE_API_BASE` | _(same origin)_ | Build-time only: set if the API lives on a different origin than the page |

### First run (creating the admin)

```bash
VELO_BIND=0.0.0.0:8080 \
VELO_CONTROL_DB=/opt/velo/control.db \
VELO_DATA_DIR=/opt/velo/data \
VELO_STATIC_DIR=/opt/velo/dist \
VELO_PUBLIC_URL=https://mail.example.com \
VELO_ADMIN_EMAIL=you@example.com \
VELO_ADMIN_PASSWORD='choose-a-strong-password' \
/opt/velo/velo-server
```

After first run you can drop `VELO_ADMIN_*`. Log in as the admin, then use the
**Admin** panel (Users icon in the sidebar) to:
- create user accounts (admin or member),
- provision each user's IMAP/SMTP mailbox (members can't see or edit credentials),
- set the global / per-user **display name** and **signature**.

New-mail notifications email each user (from the first admin mailbox) a link
that opens the message in the browser. They require at least one admin mailbox
to send from, and `VELO_PUBLIC_URL` set so the link points back at your server.

Then open `http://your-server:8080/` in a browser.

## 4. Put it behind TLS (recommended)

Run `velo-server` bound to localhost and reverse-proxy it with nginx/Caddy so
the browser uses HTTPS. Example (Caddy):

```
mail.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Backups

Everything is in the single `VELO_DB` file. Stop the server (or use the SQLite
backup API) and copy `velo.db` (plus `velo.db-wal`/`velo.db-shm` if present).

## What works today vs. later phases

- ✅ IMAP/SMTP mail over HTTP: list folders, fetch/read, reply/send,
  archive/star/move, **move to another mailbox**, attachments.
- ✅ SQLite (incl. FTS5 trigram search) via the SQL gateway.
- ✅ Per-user login + **admin/member roles** + access enforcement.
- ✅ Per-user data isolation (separate DB file per user).
- ✅ **Admin-provisioned mailboxes** — members use but can't see/edit credentials
  (stored encrypted server-side).
- ✅ **Admin-controlled display name & signature** (global or per-user; members
  can't change them).
- ✅ **New-mail email notifications** with a one-click link back into the app.
- Mail is IMAP/SMTP only (no Gmail OAuth), by design.
