//! Cross-mailbox move (Apple-Mail style): copy a message from one provisioned
//! mailbox into a folder of another, then remove the source copy.
//!
//! Per message:
//!   1. fetch full RFC822 + FLAGS + INTERNALDATE from the source (BODY.PEEK);
//!   2. skip the APPEND if the journal says it already landed, or the
//!      destination folder already holds the same Message-ID;
//!   3. otherwise APPEND to the destination folder (flags + date preserved);
//!   4. journal `appended`;
//!   5. only then `UID STORE +FLAGS (\Deleted)` + `UID EXPUNGE <uid>` on the
//!      source; journal `done` (or `flagged` if the server lacks UIDPLUS).
//!
//! Nothing is ever forwarded or re-sent over SMTP, no folder is created or
//! deleted, and the source is never touched when the APPEND failed. A crash
//! between (3) and (4) is caught on retry by the Message-ID check, so mail
//! cannot be duplicated repeatedly.

use serde::Serialize;
use sqlx::SqliteConnection;
use velo_core::imap::client::transfer::RawImapSession;

use crate::mailboxes::MailboxCreds;
use crate::state::AppState;

pub const STATUS_APPENDED: &str = "appended";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FLAGGED: &str = "flagged";

pub async fn migrate(conn: &mut SqliteConnection) {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS filing_transfers (
            src_mailbox_id TEXT NOT NULL,
            src_folder TEXT NOT NULL,
            uidvalidity INTEGER NOT NULL,
            uid INTEGER NOT NULL,
            dest_mailbox_id TEXT NOT NULL,
            dest_folder TEXT NOT NULL,
            message_id TEXT,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (src_mailbox_id, src_folder, uidvalidity, uid)
        );
        "#,
    )
    .execute(&mut *conn)
    .await
    .expect("filing_transfers migrate");
}

#[derive(Debug, Default, Serialize, Clone, PartialEq)]
pub struct TransferOutcome {
    /// Appended to the destination and removed from the source.
    pub moved: usize,
    /// Already present in the destination (journal / Message-ID); source removed.
    pub deduped: usize,
    /// Destination copy is in place but the source could only be flagged
    /// \Deleted (no UIDPLUS) — it is NOT expunged.
    pub flagged_only: usize,
    /// UID no longer in the source folder.
    pub missing: usize,
    /// Fetch/APPEND/delete failed — source left untouched (or flagged, see log).
    pub failed: usize,
}

pub(crate) struct JournalKey<'a> {
    pub src_mailbox_id: &'a str,
    pub src_folder: &'a str,
    pub uidvalidity: u32,
    pub uid: u32,
}

pub(crate) async fn journal_status(state: &AppState, k: &JournalKey<'_>) -> Option<String> {
    let mut c = state.control.lock().await;
    sqlx::query_as::<_, (String,)>(
        "SELECT status FROM filing_transfers WHERE src_mailbox_id=$1 AND src_folder=$2 AND uidvalidity=$3 AND uid=$4",
    )
    .bind(k.src_mailbox_id)
    .bind(k.src_folder)
    .bind(k.uidvalidity as i64)
    .bind(k.uid as i64)
    .fetch_optional(&mut *c)
    .await
    .ok()
    .flatten()
    .map(|(s,)| s)
}

pub(crate) async fn journal_set(
    state: &AppState,
    k: &JournalKey<'_>,
    dest_mailbox_id: &str,
    dest_folder: &str,
    message_id: Option<&str>,
    status: &str,
) -> Result<(), String> {
    let mut c = state.control.lock().await;
    sqlx::query(
        "INSERT INTO filing_transfers (src_mailbox_id, src_folder, uidvalidity, uid, dest_mailbox_id, dest_folder, message_id, status) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
         ON CONFLICT(src_mailbox_id, src_folder, uidvalidity, uid) DO UPDATE SET status=$8, updated_at=unixepoch()",
    )
    .bind(k.src_mailbox_id)
    .bind(k.src_folder)
    .bind(k.uidvalidity as i64)
    .bind(k.uid as i64)
    .bind(dest_mailbox_id)
    .bind(dest_folder)
    .bind(message_id)
    .bind(status)
    .execute(&mut *c)
    .await
    .map(|_| ())
    .map_err(|e| format!("journal write: {e}"))
}

/// Move `uids` from `src`/`src_folder` into `dest`/`dest_folder`.
/// Errors only on connection/SELECT failure (nothing touched); per-message
/// failures are counted in the outcome.
pub async fn transfer_messages(
    state: &AppState,
    src: &MailboxCreds,
    src_folder: &str,
    uids: &[u32],
    dest: &MailboxCreds,
    dest_folder: &str,
) -> Result<TransferOutcome, String> {
    let mut out = TransferOutcome::default();
    if uids.is_empty() {
        return Ok(out);
    }
    if src.id == dest.id {
        return Err("transfer: source and destination mailbox are the same (use MOVE)".into());
    }
    let mut s = RawImapSession::connect(&src.imap).await.map_err(|e| format!("{}: {e}", src.email))?;
    let uidvalidity = s.select(src_folder).await?;
    let mut d = match RawImapSession::connect(&dest.imap).await {
        Ok(d) => d,
        Err(e) => {
            s.logout().await;
            return Err(format!("{}: {e}", dest.email));
        }
    };
    // SELECT doubles as "destination folder exists" — never created.
    if let Err(e) = d.select(dest_folder).await {
        s.logout().await;
        d.logout().await;
        return Err(format!("{}: destination folder unavailable: {e}", dest.email));
    }

    for &uid in uids {
        let key = JournalKey { src_mailbox_id: &src.id, src_folder, uidvalidity, uid };
        let journaled = journal_status(state, &key).await;

        let msg = match s.fetch_full(uid).await {
            Ok(Some(m)) => m,
            Ok(None) => {
                out.missing += 1;
                continue;
            }
            Err(e) => {
                tracing::warn!("transfer: fetch {} uid {uid} failed: {e}", src.email);
                out.failed += 1;
                continue;
            }
        };

        let mut already = matches!(journaled.as_deref(), Some(STATUS_APPENDED | STATUS_DONE | STATUS_FLAGGED));
        if !already {
            if let Some(mid) = msg.message_id.as_deref() {
                match d.search_message_id(mid).await {
                    Ok(hits) => already = !hits.is_empty(),
                    Err(e) => {
                        // Can't prove it's absent — don't risk a duplicate this round.
                        tracing::warn!("transfer: dedupe search in {} failed: {e}", dest.email);
                        out.failed += 1;
                        continue;
                    }
                }
            }
        }

        if !already {
            if let Err(e) = d.append(dest_folder, &msg.flags, msg.internal_date.as_deref(), &msg.body).await {
                tracing::warn!("transfer: APPEND {} → {}/{dest_folder} uid {uid} failed: {e}; source untouched", src.email, dest.email);
                out.failed += 1;
                continue;
            }
        }
        // Record before deleting so a crash here can't cause a re-append.
        if let Err(e) = journal_set(state, &key, &dest.id, dest_folder, msg.message_id.as_deref(), STATUS_APPENDED).await {
            tracing::warn!("transfer: {e}; not deleting source uid {uid}");
            out.failed += 1;
            continue;
        }
        match s.delete_uid(uid).await {
            Ok(true) => {
                let _ = journal_set(state, &key, &dest.id, dest_folder, msg.message_id.as_deref(), STATUS_DONE).await;
                if already { out.deduped += 1 } else { out.moved += 1 }
            }
            Ok(false) => {
                tracing::warn!("transfer: {} lacks UIDPLUS; uid {uid} flagged \\Deleted but not expunged", src.email);
                let _ = journal_set(state, &key, &dest.id, dest_folder, msg.message_id.as_deref(), STATUS_FLAGGED).await;
                out.flagged_only += 1;
            }
            Err(e) => {
                tracing::warn!("transfer: delete source {} uid {uid} failed: {e} (copy is in destination)", src.email);
                out.failed += 1;
            }
        }
    }
    s.logout().await;
    d.logout().await;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::new_id;

    #[tokio::test]
    async fn journal_roundtrip() {
        let dir = std::env::temp_dir().join(format!("velo-xfer-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState::init(dir.join("c.db").to_str().unwrap(), dir.clone()).await;
        let k = JournalKey { src_mailbox_id: "a", src_folder: "INBOX", uidvalidity: 9, uid: 5 };
        assert_eq!(journal_status(&state, &k).await, None);
        journal_set(&state, &k, "b", "INBOX", Some("<m@x>"), STATUS_APPENDED).await.unwrap();
        assert_eq!(journal_status(&state, &k).await.as_deref(), Some(STATUS_APPENDED));
        journal_set(&state, &k, "b", "INBOX", Some("<m@x>"), STATUS_DONE).await.unwrap();
        assert_eq!(journal_status(&state, &k).await.as_deref(), Some(STATUS_DONE));
        // Different UIDVALIDITY is a different message.
        let k2 = JournalKey { uidvalidity: 10, ..k };
        assert_eq!(journal_status(&state, &k2).await, None);
    }
}
