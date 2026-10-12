//! Declarative filing seed (config/filing-seed.json, embedded at build time;
//! override with VELO_SEED_FILE). Imported idempotently on startup:
//! creates missing mailboxes (owned by the first admin), refreshes a mailbox's
//! password from its `password_env` when that env var is set, and inserts
//! missing Reads rules (notifyBefore = false). Never deletes anything.

use serde::Deserialize;

use crate::filer::{normalize_sender, ACTION_MOVE_READS};
use crate::server_crypto;
use crate::state::{new_id, AppState};

const EMBEDDED: &str = include_str!("../config/filing-seed.json");

#[derive(Deserialize)]
struct Seed {
    #[serde(default)]
    mailboxes: Vec<SeedMailbox>,
}

#[derive(Deserialize)]
struct SeedMailbox {
    email: String,
    imap_host: String,
    imap_port: i64,
    imap_security: String,
    smtp_host: String,
    smtp_port: i64,
    smtp_security: String,
    username: Option<String>,
    password_env: String,
    #[serde(default)]
    reads_senders: Vec<String>,
}

pub async fn import(state: &AppState) {
    if std::env::var("VELO_SEED").map(|v| v == "0").unwrap_or(false) {
        return;
    }
    let text = match std::env::var("VELO_SEED_FILE") {
        Ok(p) => match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("seed: cannot read {p}: {e}");
                return;
            }
        },
        Err(_) => EMBEDDED.to_string(),
    };
    let seed: Seed = match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("seed: invalid JSON: {e}");
            return;
        }
    };
    for mb in seed.mailboxes {
        import_mailbox(state, mb).await;
    }
}

async fn import_mailbox(state: &AppState, mb: SeedMailbox) {
    let password = std::env::var(&mb.password_env).ok().filter(|p| !p.is_empty());
    let mut control = state.control.lock().await;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT id, owner_user_id FROM mailboxes WHERE lower(email) = lower($1)")
            .bind(&mb.email)
            .fetch_optional(&mut *control)
            .await
            .ok()
            .flatten();
    if let Some((id, _)) = &existing {
        // Keep connection settings in sync with the seed (never touches rules/other rows).
        let _ = sqlx::query(
            "UPDATE mailboxes SET imap_host=$2, imap_port=$3, imap_security=$4, smtp_host=$5, \
             smtp_port=$6, smtp_security=$7 WHERE id = $1",
        )
        .bind(id).bind(&mb.imap_host).bind(mb.imap_port).bind(&mb.imap_security)
        .bind(&mb.smtp_host).bind(mb.smtp_port).bind(&mb.smtp_security)
        .execute(&mut *control)
        .await;
    }
    let (id, owner) = match (existing, password) {
        (Some((id, owner)), Some(pw)) => {
            let _ = sqlx::query("UPDATE mailboxes SET password_enc = $2 WHERE id = $1")
                .bind(&id)
                .bind(server_crypto::encrypt(&pw))
                .execute(&mut *control)
                .await;
            (id, owner)
        }
        (Some(x), None) => x,
        (None, None) => {
            tracing::warn!("seed: {} missing and ${} unset; skipping", mb.email, mb.password_env);
            return;
        }
        (None, Some(pw)) => {
            let admin: Option<(String,)> =
                sqlx::query_as("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
                    .fetch_optional(&mut *control)
                    .await
                    .ok()
                    .flatten();
            let Some((owner,)) = admin else {
                tracing::warn!("seed: no admin user; skipping {}", mb.email);
                return;
            };
            let id = new_id();
            let res = sqlx::query(
                "INSERT INTO mailboxes (id, owner_user_id, email, display_name, imap_host, imap_port, \
                 imap_security, smtp_host, smtp_port, smtp_security, username, password_enc, accept_invalid_certs) \
                 VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,0)",
            )
            .bind(&id).bind(&owner).bind(&mb.email)
            .bind(&mb.imap_host).bind(mb.imap_port).bind(&mb.imap_security)
            .bind(&mb.smtp_host).bind(mb.smtp_port).bind(&mb.smtp_security)
            .bind(&mb.username).bind(server_crypto::encrypt(&pw))
            .execute(&mut *control)
            .await;
            if let Err(e) = res {
                tracing::warn!("seed: create {} failed: {e}", mb.email);
                return;
            }
            tracing::info!("seed: created mailbox {}", mb.email);
            (id, owner)
        }
    };
    let mut added = 0;
    for s in &mb.reads_senders {
        let Ok(sender) = normalize_sender(s) else {
            tracing::warn!("seed: bad sender {s}");
            continue;
        };
        let r = sqlx::query(
            "INSERT OR IGNORE INTO filing_rules (id, user_id, mailbox_id, sender_email, action, enabled, notify_before) \
             VALUES ($1,$2,$3,$4,$5,1,0)",
        )
        .bind(new_id()).bind(&owner).bind(&id).bind(&sender).bind(ACTION_MOVE_READS)
        .execute(&mut *control)
        .await;
        if let Ok(r) = r { added += r.rows_affected(); }
    }
    tracing::info!("seed: {} — {added} new rule(s), {} in seed", mb.email, mb.reads_senders.len());
}

#[cfg(test)]
mod tests {
    #[test]
    fn embedded_seed_parses() {
        let s: super::Seed = serde_json::from_str(super::EMBEDDED).unwrap();
        assert_eq!(s.mailboxes[0].reads_senders.len(), 25);
    }
}
