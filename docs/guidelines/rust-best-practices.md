# Rust Best Practices

Required reading for `src-tauri/` work. These rules are the Rust counterpart of
Twiglit's Fresh guideline: a written doctrine that can later become grep audits
(when Velo has a Deno or Rust reporting kernel). **Do not add a Deno reporting
package to this repo until the app itself is Deno.**

Two kinds of rule:

- **Checkable** — a grep (or a future architecture test) can find a violation.
  Each has a stable `rule-id`. Inline suppressions use the same shape as slop
  audits: `// slop: allow <rule-id> — reason`.
- **Review-only** — judgment, not a pattern. Call them out in review; do not
  pretend a regex can enforce them.

The IMAP scheduler in `src-tauri/velo-core/src/imap/scheduler.rs` is the
reference implementation for several of these (priority, Drop-owned turn,
cancelled waiters skipped). Copy that shape; do not re-derive it in TypeScript.

## Checkable

### `spawn-without-join`

Every `tokio::spawn` in production code must be owned: the `JoinHandle` is
stored and aborted or joined on shutdown, or the task is clearly
fire-and-forget with a comment that says why dropping it is safe.

Tests may spawn and await. Process-lifetime tasks (the server) still need a
place that can cancel them.

```rust
// ❌
tokio::spawn(async move { run_sync(account).await });

// ✅
let handle = tokio::spawn(async move { run_sync(account).await });
// caller keeps `handle` and aborts it when the account is removed
```

### `mutex-held-across-await`

Do not hold a `tokio::sync::Mutex` guard across `.await` unless the critical
section is the wait. Prefer a `std::sync::Mutex` for short, non-awaiting
sections — that is why the IMAP scheduler uses a std mutex: `Drop` cannot
`.await`, and a turn leaked on `?` would leave the account permanently busy.

```rust
// ❌
let guard = state.lock().await;
do_imap(&mut *guard).await;

// ✅  lock, copy what you need, drop, then await
let config = { state.lock().await.config.clone() };
do_imap(&config).await;
```

### `blocking-in-async`

No `std::thread::sleep`, blocking `std::fs`, `std::net`, or other thread-blocking
calls inside `async fn`. Use `tokio::fs` / `tokio::time::sleep`, or
`spawn_blocking` for genuinely synchronous work (SQLite, if we ever take the
connection off the plugin).

### `imap-work-unlabeled`

Every IMAP operation that uses a pooled session must go through
`Scheduler::acquire` with an explicit `Priority`. Interactive is the default
(`Priority::from_label(None)`); background sync must pass `"background"`.
Mislabelling a user action as background is the failure mode this exists to
prevent.

Tauri commands stay thin: parse `priority: Option<String>`, call
`velo_core::ops`. See `src-tauri/src/commands.rs`.

### `sql-string-concat`

Do not build SQL with `format!` / `push_str` from values that came from the
user, IPC, or the network. Parameterized queries only.

### `swallow-result`

No `let _ =` on a `Result` and no `.ok()` used only to discard the error, in
non-test `src-tauri/` code. If ignoring a result is correct (cancelled waiter,
poisoned mutex recovery), comment why. The scheduler's `let _ = rx.await` is
an allowed case: a closed channel means the holder vanished, and proceeding is
better than hanging.

### `unwrap-in-prod`

No `.unwrap()` / `.expect()` on fallible calls in non-test production code.
`unwrap_or_else(|p| p.into_inner())` on a poisoned std mutex is fine when
recovering shared state is better than panicking every waiter.

### `todo-in-prod`

No `todo!()`, `unimplemented!()`, or `unimplemented(` in non-test `src-tauri/`.
Finish the path or return an error the UI can show.

### `allow-without-reason`

Every `#[allow(...)]` needs a trailing comment that names the lint and why.
Bare allows rot into unreviewable silence.

### `fat-tauri-command`

A `#[tauri::command]` in `src-tauri/src/` is a transport adapter: deserialize,
call `velo_core::ops` (or a similarly shared module), serialize. IMAP/SMTP
logic, pooling, and scheduling do not live in the command file. `commands.rs`
is the pattern; do not grow new bodies there.

### `module-monolith`

A production `.rs` file over ~800 lines that is not a generated or purely
declarative module (type dumps, match tables) should be split by
responsibility. The audit later will count lines; until then, treat 800 as a
review stop.

## Review-only

These will not grep cleanly. Still apply them.

### Honest done

A sync, send, or fetch is not "done" because the task spawned. It is done when
the user-visible state is consistent (DB written, UI event emitted, or a
durable failure recorded). Progress that lies is worse than a spinner.

### One SQLite writer

SQLite is one writer. Do not open a second connection "just for this command"
and do not run migrations from a background task while the UI is querying.
Queue writes; keep the plugin connection as the process-wide writer.

### User beats bulk

Interactive IMAP already jumps the scheduler queue
(`Priority::Interactive` vs `Background`). Gmail API and TypeScript sync
paths must follow the same doctrine: a user archive/send/open does not wait
behind a mailbox walk. Chunk bulk work so it can yield.

### Drain then finalize

On cancel or account removal: stop admitting new work, drain or abort in-flight
work that is safe to abandon, then tear down the session. Do not logout while
a command is in flight; do not leave the account `busy` with nobody holding the
turn (the `Turn` `Drop` impl exists so `?` cannot leak this).

### Least privilege

Tauri capabilities, filesystem scopes, and network hosts stay as tight as the
feature needs. New plugins need an explicit permission in
`src-tauri/capabilities/default.json` — not a blanket allow.

### 400ms foreground latency

Foreground actions (open thread, send, archive, search keystroke → list)
target under 400ms to first useful paint or confirmed local state. If a path
cannot, the PR says why, what the user sees while waiting, and how we will
measure it. Background sync has no such cap, but it must yield to foreground
work (see User beats bulk).

## What this is not

- Not a replacement for `cargo test` / `cargo clippy`.
- Not a reason to vendor `@realdigit/test-reporting` here. That package is Deno;
  Velo is not. When the reporting kernel exists in Rust (or Velo is Deno), the
  **checkable** rules above become the first audits — same ids, same sidecar
  shape, same `data/status.json` contract.
