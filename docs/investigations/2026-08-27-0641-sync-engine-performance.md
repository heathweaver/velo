# Investigation: Sync engine performance & first-sync completion

**Timestamp**: 2026-08-27 06:41 CEST **Status**: Partially implemented (`perf/sync-metadata-first`; IMAP headers-only, watermark and UI fixes landed on `feat/newsletter-skim-and-marks`, 2026-10-05) **Area**: sync engine, Gmail API sync, IMAP sync, SQLite writes,
first-sync UX

> Prior investigations: none found in this repo before this file was opened.

## Problem Statement

Velo's sync engine feels unacceptably slow for an email client. On a live
three-account setup (`sync_period_days = 0`), first sync is either still running,
marked complete with stale folder coverage, or failing to persist delta updates
with `database is locked` errors. The inbox is not usable quickly because the
client downloads full message bodies for every message before treating sync as
done, serialises accounts and SQLite writes, and throttles IMAP folder walks.

## Rationale

Email clients are judged in the first minutes after account add. If initial sync
takes tens of minutes (or appears hung), users churn regardless of keyboard
shortcuts or AI features. Competitors — both desktop-native and local-first
Rust projects — solve this with metadata-first sync, progressive UI, dedicated
search indexes, and incremental checkpoints. We need to understand what they do
differently before redesigning our pipeline.

---

## Hypotheses

### H1: First sync is not finished for all accounts

**Test**: Query live app DB (`~/Library/Application Support/com.velomail.app/velo.db`)
for `accounts.history_id`, thread/message counts, and `folder_sync_state.last_sync_at`.
Check `velo-webview.log` for active sync errors on 2026-08-27.

**Run**:

```
sqlite3 "~/Library/Application Support/com.velomail.app/velo.db" \
  "SELECT email, provider, history_id, sync_window_days FROM accounts;"

rg "2026-08-27" velo-webview.log | rg -c "Failed to re-sync thread"
```

**Result**: Two IMAP accounts have `imap-synced-*` history IDs but realdigit.co
shows folders last synced Aug 12–17 while INBOX/Sent/Trash updated Aug 27.
Gmail has a real `history_id` but 295 thread re-sync failures today with DB lock
errors. Setting is `sync_period_days = 0` (all mail).

**Verdict**: `correct`

---

### H2: Full-body-first sync is the dominant latency source

**Test**: Read sync code paths — what is fetched on initial sync vs on thread open?

**Run**:

```
src/services/gmail/sync.ts     → getThread(id, "full") for every thread stub
src/services/imap/imapSync.ts  → BODY.PEEK[] via Rust uid_fetch
src-tauri/velo-core/src/imap/client.rs → "UID FLAGS INTERNALDATE BODY.PEEK[]"
```

**Result**: Both Gmail and IMAP initial sync download complete MIME bodies up
front. Gmail uses 10 concurrent API fetches but serialises SQLite writes.
IMAP walks folders sequentially with 1 s inter-folder delay and fetches 50
messages per IPC batch (200 UIDs per chunk).

**Verdict**: `correct`

---

### H3: SQLite write contention is causing active sync failures

**Test**: Compare initial vs delta Gmail sync — does delta wrap stores in
`withTransaction`? Count lock errors in today's log.

**Run**:

```
grep withTransaction src/services/gmail/sync.ts   # initial sync: yes (line ~275)
grep withTransaction src/services/gmail/sync.ts   # deltaSync processAndStoreThread: no (line ~403)

rg "database is locked" velo-webview.log | rg "2026-08-27" | wc -l
```

**Result**: Delta sync calls `processAndStoreThread` without `withTransaction`
while running 10 concurrent thread re-fetches. Logs show hundreds of
`Failed to re-sync thread …: database is locked` plus `pool timed out` today.
DB is 818 MB with 29 MB WAL.

**Verdict**: `correct`

---

### H4: Fast email projects use metadata-first + separate search index

**Test**: Survey open-source mail/sync projects that advertise fast indexing.
Document their stated architecture.

**Run**: Web/repo survey (see **Comparable projects** below).

**Result**: Every project promising fast search or fast first-run uses at least
one of: metadata-only initial pass, lazy body fetch, dedicated search engine
(Tantivy), streaming/chunk commits, or a background sync worker decoupled from
UI. None fetch full bodies for the entire mailbox before showing an inbox.

**Verdict**: `correct`

---

## TL;DR — live state (2026-08-27)

| Account | Provider | Done signal | Threads | Messages | Verdict |
|---------|----------|-------------|---------|----------|---------|
| heath.weaver@twigl.it | IMAP | `imap-synced-*` | 124 | 144 | Likely complete |
| heath.weaver@realdigit.co | IMAP | `imap-synced-*` | 7,114 | 15,596 | Marked done; Archive etc. stale since Aug 12–17 |
| heath.weaver@remote-executive.com | Gmail | `history_id=393888` | 1,301 | 1,506 | Delta sync failing (295 lock errors today) |

**Setting:** `sync_period_days = 0` → sync all mail (worst case for initial sync).

**Log excerpt (Gmail, 2026-08-27 ~04:33–04:44 UTC):**

```
Failed to re-sync thread …: database is locked        (×295)
Failed to re-sync thread …: pool timed out while waiting for an open connection
[syncManager] Sync failed for account …: database is locked
```

---

## Our sync architecture (summary)

### Orchestration (`syncManager.ts`)

- 30 s background interval; accounts synced **sequentially**
- Window widen (`sync_period_days` 30 → 0) triggers full rescan (`syncWindow.ts`)

### Gmail (`gmail/sync.ts`)

1. `listLabels`
2. `listThreads` (100/page)
3. `getThread(full)` × N — 10 concurrent fetch, serialised DB write (initial only)

Delta: `history.list` → re-fetch affected threads with `getThread(full)`, 10
concurrent, **no** `withTransaction` on store.

### IMAP (`imap/imapSync.ts` + Rust)

1. List/map folders
2. Per folder (sequential, 1 s delay): SEARCH UIDs → FETCH `BODY.PEEK[]` in
   batches of 50 / chunks of 200
3. JWZ threading pass over all headers
4. Materialise threads, delete placeholders

`modseq` always stored as `null` — CONDSTORE/QRESYNC unused.

### Constants

```
SYNC_INTERVAL_MS = 30_000
BATCH_SIZE = 50, CHUNK_SIZE = 200
INTER_FOLDER_DELAY_MS = 1_000
CIRCUIT_BREAKER_DELAY_MS = 15_000
Gmail parallelLimit = 10
Rust: uid_fetch(..., "UID FLAGS INTERNALDATE BODY.PEEK[]")
```

---

## Comparable projects — what they promise and how

Projects that explicitly optimise for fast sync/indexing. Grouped by pattern.

### 1. Metadata-first, bodies lazy

| Project | Claim | What they do |
|---------|-------|--------------|
| **[mail-index](https://github.com/unsoldgroup/mail-index)** | "Metadata for whole mailbox in minutes; bodies fetched selectively" | Progressive Gmail sync: index headers for entire mailbox (~50 msg/min claimed), full text only for messages that matter. Local index ~1.5% of Gmail size. MCP server reads local index; hits Gmail again only for missing bodies. Recommends `--since 1mo` first, expand later. |
| **[allodia sync engine](https://github.com/allodia-eu/email-calendar-sync-engine)** | "Streaming sync… UI can render recent mail before full mailbox finishes" | Rust PIM engine: normalised model across JMAP/IMAP/CalDAV/Graph. Commits chunks as they arrive. Metadata + raw payloads preserved; search via SQLite FTS. Designed to embed in native apps. |
| **Google Gmail API guidance** | Partial sync for responsiveness | [Sync guide](https://developers.google.com/gmail/api/guides/sync): list recent messages first; use `history.list` for delta; defer full bodies. `threads.list?format=metadata` avoids N× `threads.get` for inbox paint. |
| **Thunderbird / Apple Mail** | Instant-ish inbox | FETCH `ENVELOPE FLAGS UID` headers only; bodies on open. Persistent connection + IDLE. |

**Velo gap:** We always `getThread(format=full)` and IMAP `BODY.PEEK[]`.

### 2. Dedicated search index (separate from message store)

| Project | Claim | What they do |
|---------|-------|--------------|
| **[Pebble](https://github.com/RichardZhong/Pebble)** | "Fast full-text search" | Tauri + Rust workspace: SQLite for mail data, **Tantivy** for search index, bodies on disk. Crate split (`pebble-mail`, `pebble-store`, `pebble-search`). |
| **[Bichon](https://github.com/rustmailer/bichon)** | "High-performance archiver" | Rust IMAP archiver: **Tantivy** (Zstd) for FTS, **Fjall** for blob bodies, memdb for metadata. Async envelope indexing queue; batch commit every 1k docs / 60 s. Multi-account concurrent download. Content-hash dedup (BLAKE3). |
| **[imapped](https://github.com/esaiaswestberg/imapped)** | "Blazing-fast caching and search" | IMAP **caching proxy**: mirrors upstream into Postgres (metadata) + object storage (bodies). Serves clients over IMAP locally. **Tantivy** for full-text search. Sync engine + upstream reconciliation; mutations pushed back. |
| **[ESS](https://github.com/krasmussen37/ess)** | "Sub-second search across thousands" | SQLite canonical store + **Tantivy** index. Gmail/Graph delta sync. Honest about Gmail initial sync slowness (1 HTTP req/message); delta is fast. |
| **[msgvault](https://github.com/foreseaz/msgvault)** | "Search at the speed of thought" | Gmail backup: SQLite FTS5 + **DuckDB/Parquet** analytics cache. Resumable checkpoints. Content-addressed attachment dedup. |

**Velo gap:** FTS5 updated inline on every message insert during sync — write
amplification on the same SQLite file that sync is fighting over.

### 3. Background worker / streaming pipeline

| Project | Claim | What they do |
|---------|-------|--------------|
| **[pmh-only/mail](https://deepwiki.com/pmh-only/mail/3.1-imap-synchronization)** | Efficient IMAP sync | Dual-process: background worker owns IMAP connections + job queue. STATUS fast-path (`UIDNEXT` / `HIGHESTMODSEQ`) before fetch. IDLE watchers per mailbox. Local actions queued as `imap_job`, replayed to server. |
| **[Twenty IMAP refactor](https://github.com/twentyhq/twenty/pull/14053)** | "Syncs are faster now" | UID-based fetch (no Message-ID lookups). **QRESYNC** when available. Composite folder+UID keys. Tested on Gmail, Dovecot, FastMail. |
| **[Bichon IMAP sync](https://deepwiki.com/rustmailer/bichon/3.5-imap-synchronization)** | High-concurrency multi-account | Periodic tasks per account. UID SEARCH differential sync. Configurable `download_batch_size`. UI shows live progress. |
| **[mailintel](https://github.com/ghassan-ai-projects/email-intelligence-platform)** | Local knowledge base | **mbsync → Maildir** (immutable source) → ingest to SQLite (FTS5 + vectors). Sync/ingest/enrich as separate stages. Watch mode for continuous loop. |

**Velo gap:** Sync runs in JS main thread path via Tauri IPC; one account at a
time; no STATUS gate; no QRESYNC; artificial inter-folder delays.

### 4. Commercial "fast" clients (architecture, not open source)

| Client | Claim | What they actually do |
|--------|-------|----------------------|
| **Superhuman** | "Built for speed" / 100 ms rule | Local SQLite cache of emails; preload/prerender likely-next threads; metadata-first UI; same Gmail API but optimised read path + keyboard UX. [Blog post](https://blog.superhuman.com/superhuman-is-built-for-speed/) |
| **Spark / Marco / Edison** | Instant mobile inbox | **Backend server** maintains IMAP connections, builds index, relays push. Device reads pre-synced cache. Trade-off: mail transits vendor infra. [Marco IMAP post](https://marcoapp.io/blog/how-imap-actually-works) |

**Velo gap:** Local-first (good for privacy) but without the optimisations
desktop-native or backend-sync clients use.

---

## Cross-project patterns (what actually makes sync fast)

1. **Inbox paint in seconds** — headers/metadata for recent mail first; bodies
   on open or background prefetch queue.
2. **Separate concerns** — message store vs search index vs blob storage (avoid
   one SQLite writer doing everything).
3. **Stream commits** — UI updates after each chunk, not after full mailbox +
   threading pass.
4. **Incremental checkpoints** — resumable sync; honest "done" per folder.
5. **IMAP extensions** — STATUS before SEARCH; CONDSTORE/QRESYNC; IDLE not 30 s
   poll.
6. **Parallelism** — concurrent accounts/folders with a single writer queue, not
   concurrent writers.
7. **Scoped initial sync** — recent window first (`--since 1mo`), expand on
   demand; never default to "all mail".
8. **Defer enrichment** — filters, AI categorization, smart labels after inbox
   is visible.

---

## Gap analysis — Velo vs field

| Capability | Velo today | Fast-project pattern |
|------------|------------|-------------------|
| Inbox before full sync | No | Yes (metadata first) |
| Body fetch | Always full upfront | Lazy / prefetch |
| Search index | SQLite FTS5 inline | Tantivy or deferred FTS build |
| IMAP fetch | `BODY.PEEK[]` | Headers first; body on read |
| IMAP incremental | UID > last_uid | + STATUS gate, QRESYNC |
| Parallelism | 1 account, 1 folder chain | Multi-folder/account + writer queue |
| Sync scope default | User set to 0 (all mail) | Recent window; opt-in full |
| Done signal | Account-level flag | Per-folder success |

---

## 2026-10-05 pass (`feat/newsletter-skim-and-marks`, PR #6)

The checklist below was written against `perf/sync-metadata-first`, which was
never merged; only its Gmail `format=metadata` switch and `ensureMessageBodies`
had been carried onto this branch. IMAP was still fetching `BODY.PEEK[]` for
every message. This pass re-audited `main`-based code and landed:

| # | Bottleneck / defect | Fix |
|---|---------------------|-----|
| 1 | IMAP initial sync downloads every full body (`BODY.PEEK[]`) | `imap_fetch_messages` takes `headersOnly`; Rust fetches `UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER]` and parses with `parse_message_headers` (body/snippet/attachments forced to *unknown*, not `""`, so `ensureMessageBodies` still fetches them). Used for initial sync, new/rescanned folders, UIDVALIDITY resyncs, and delta passes with > `DELTA_FULL_BODY_MAX` (25) new messages. Small deltas (fresh mail) stay full so filters/skim have bodies. |
| 2 | `format=metadata` returns "only IDs, labels and headers" (Gmail docs), but the parser dereferenced `part.body.data` / `part.body.attachmentId` unconditionally — a payload without `body` throws and the thread is dropped from sync | Optional chaining in `messageParser`; `body?` in the type; tests for a metadata-shaped message. The `multipart/mixed` attachment hint only applies if Gmail includes `mimeType` |
| 3 | Gmail delta re-fetched *every* affected thread as `full`, even for read/archive/star changes | `full` only for threads in `messagesAdded`; `metadata` for label-only changes |
| 4 | Gmail delta advanced `history_id` past threads that failed to store | Only advance when every thread stored; a 404 thread is deleted locally and not counted as a failure (else it would pin history forever) |
| 5 | IMAP initial sync `continue`d past a failed chunk and still raised `last_uid` past the hole | UIDs sorted ascending; a failed chunk stops the folder; watermark is the contiguous prefix; a folder whose first chunk fails records nothing (delta treats it as new and searches with the window) |
| 6 | Re-syncing headers-only would blank stored snippets | `snippet = COALESCE(NULLIF(new, ''), snippet)` in TS and Rust upserts (threads + messages); `fillThreadSnippetIfEmpty` on first body load |
| 7 | Thread open blocked on the network: spinner until bodies downloaded; stale results could overwrite the next thread | Headers render from disk immediately; bodies fill in after; cancelled on thread switch; per-message in-flight dedupe; 4-way concurrency, newest first; writes queued through `withTransaction` |
| 8 | `onSyncStatus` was a single slot: App and SyncButton overwrote each other, and either unsubscribing silenced both — finished syncs stopped refreshing the list | Listener set |
| 9 | Every 30 s poll per account dispatched `velo-sync-done` → full list + metadata reload even when nothing changed | `deltaSync` returns the change count; IMAP delta uses `storedCount`; `done` carries `{ changed }` and App skips the refresh when false |
| 10 | Thread list N+1: `getThreadLabelIds` per row (50/page); smart folders / All Inboxes did label + thread lookups per row (100/page) | `getThreadLabelIdsBatch` / `getThreadsByRefs` — one query per account per page |
| 11 | IMAP `List-Unsubscribe` never extracted (mail-parser parses it as an address list) — IMAP newsletters invisible to unsubscribe + newsletter rules | Read the raw header, unfolded |
| 12 | Messages with no text/HTML part were re-downloaded on every open | Stored with `body_text = ''` once fetched; `messageNeedsBody` checks for `NULL` |

Known trade-offs: body full-text search only covers mail whose body has been
loaded (FTS triggers index it on open); `has_attachments` for unopened mail is
a `multipart/mixed` heuristic; the web transport ignores `headersOnly` (server
route unchanged) and keeps full fetches.

## Recommended next steps

### P0 — Stabilise

- [x] Fix delta sync write serialisation (`storeThread` wraps `withTransaction`)
- [x] Don't skip past failed chunks / advance watermarks past failed stores (Gmail history_id, IMAP last_uid). Skipped folders are left unrecorded so delta resumes them as new folders
- [ ] Add sync telemetry: phase timings, bytes fetched, lock wait time

### P1 — Metadata-first (biggest UX win)

- [x] Gmail: `threads.list` + `format=metadata` for inbox; defer `format=full`
- [x] IMAP: header FETCH pass; body via existing `imap_fetch_message_body`
- [x] Lazy body load on thread open (`ensureMessageBodies`)
- [ ] Show inbox after first header page (~100 messages)
- [ ] Background body prefetch for recent INBOX mail (keeps body search + skim warm)
- [ ] Prefetch next thread's bodies on j/k navigation

### P2 — Reduce redundant work

- [x] Default sync window 30 days; `0` = all mail (no falsy fallback)
- [ ] Parallel IMAP folders (2–3) with shared connection pool
- [ ] Remove/reduce `INTER_FOLDER_DELAY_MS` when server allows
- [ ] Defer filters / AI / smart labels until after inbox paint
- [x] Skip list reload when a poll changed nothing; batch thread-list label lookups
- [ ] Preserve scroll/pages on sync reload (reload replaces the list with page 1)
- [ ] Batch Gmail thread stores through a Rust `db_store_*` command like IMAP's `db_store_chunk`

### P3 — Modern IMAP + indexing

- [ ] CONDSTORE / QRESYNC (`HIGHESTMODSEQ` already returned, stored as null)
- [ ] STATUS pre-check before SEARCH/FETCH
- [ ] Evaluate Tantivy for search (decouple from sync write path)
- [ ] Rust-side sync worker decoupled from UI thread

---

## Key files

| Area | Path |
|------|------|
| Orchestration | `src/services/gmail/syncManager.ts` |
| Gmail sync | `src/services/gmail/sync.ts` |
| IMAP sync | `src/services/imap/imapSync.ts` |
| Sync window | `src/services/sync/syncWindow.ts` |
| DB mutex | `src/services/db/connection.ts` |
| IMAP fetch (Rust) | `src-tauri/src/imap/client.rs` |
| Live DB | `~/Library/Application Support/com.velomail.app/velo.db` |
| Live logs | `~/Library/Application Support/com.velomail.app/velo-webview.log` |

---

## References

- [Google Gmail API sync guide](https://developers.google.com/gmail/api/guides/sync)
- [Nylas: Gmail pagination & sync](https://developer.nylas.com/docs/cookbook/email/gmail-api-pagination-sync/)
- [Superhuman: built for speed](https://blog.superhuman.com/superhuman-is-built-for-speed/)
- [Marco: how IMAP works / why backends exist](https://marcoapp.io/blog/how-imap-actually-works)
- [mail-index](https://github.com/unsoldgroup/mail-index) — progressive metadata sync
- [Pebble](https://github.com/RichardZhong/Pebble) — SQLite + Tantivy
- [Bichon](https://github.com/rustmailer/bichon) — Rust archiver + Tantivy/Fjall
- [imapped](https://github.com/esaiaswestberg/imapped) — IMAP caching proxy
- [allodia sync engine](https://github.com/allodia-eu/email-calendar-sync-engine) — streaming sync
- [ESS](https://github.com/krasmussen37/ess) — SQLite + Tantivy MCP search
- [msgvault](https://github.com/foreseaz/msgvault) — Gmail backup + DuckDB analytics
- [Twenty IMAP refactor (QRESYNC)](https://github.com/twentyhq/twenty/pull/14053)
- [pmh-only/mail IMAP sync](https://deepwiki.com/pmh-only/mail/3.1-imap-synchronization)
