//! Server-side newsletter / Reads filer (scaffold).
//!
//! Defaults (locked product policy):
//! - File into IMAP **Reads** (top-level preferred)
//! - Notify before file; **new-mail only**; **no delete**
//! - Disabled unless `VELO_FILER=1`
//!
//! MCP tools over hosted velo-server HTTP come later — this module only
//! reserves schema + a no-op background task so the wiring stays compile-safe.

use sqlx::SqliteConnection;
use std::sync::Arc;

use crate::state::AppState;

/// Create filing tables on the control DB (shared rule metadata).
/// Per-mailbox MOVE state can move to user data DBs in a later slice.
pub async fn migrate(conn: &mut SqliteConnection) {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS filing_rules (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            mailbox_id TEXT,
            sender_email TEXT,
            action TEXT NOT NULL DEFAULT 'move_reads',
            enabled INTEGER NOT NULL DEFAULT 1,
            notify_before INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        "#,
    )
    .execute(&mut *conn)
    .await
    .expect("filing_rules migrate");

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS filing_state (
            id TEXT PRIMARY KEY,
            mailbox_id TEXT NOT NULL,
            folder_path TEXT,
            last_uid INTEGER,
            last_notified_at INTEGER,
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        "#,
    )
    .execute(&mut *conn)
    .await
    .expect("filing_state migrate");
}

/// Spawn the filer loop when `VELO_FILER=1`. Default off.
pub fn spawn(state: AppState) {
    let enabled = std::env::var("VELO_FILER")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !enabled {
        tracing::info!("velo filer disabled (set VELO_FILER=1 to enable)");
        return;
    }

    tracing::info!("velo filer enabled — stub loop (MOVE/notify not implemented yet)");
    let state = Arc::new(state);
    tokio::spawn(async move {
        loop {
            // Stub: real implementation will poll new mail, notify, then MOVE.
            let _ = state.as_ref();
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
