//! Server-side newsletter / Reads filer.
//!
//! A background poller (modeled on `notifier.rs`) watches each provisioned
//! mailbox's INBOX. When new mail arrives whose From address matches an enabled
//! `filing_rules` row for that mailbox, the owner is notified and the message
//! is MOVEd into the mailbox's **Reads** folder.
//!
//! Locked product policy:
//! - File into IMAP **Reads**: a top-level folder named exactly `Reads` is
//!   preferred; `INBOX.Reads` / `INBOX/Reads` is the fallback. The filer never
//!   creates or deletes folders — with no Reads folder, matches are skipped.
//! - **Notify before file**: when the rule has `notify_before` and an admin
//!   sender mailbox exists, an email goes to the mailbox owner first (same
//!   transport as the new-mail notifier). Without a sender it is logged. The
//!   move then happens after `VELO_FILER_NOTIFY_DELAY` seconds.
//! - **New-mail only**: a per-mailbox high-water UID in `filing_state`; the
//!   first sight of a mailbox only records the mark (no backfill).
//! - **No delete**: the only action is `move_reads` (IMAP MOVE).
//! - Disabled unless `VELO_FILER=1`.
//!
//! Config:
//!   VELO_FILER               "1"/"true" to enable (default off)
//!   VELO_FILER_INTERVAL      seconds between polls (default 120)
//!   VELO_FILER_NOTIFY_DELAY  seconds between notify and move (default 5)
//!   VELO_PUBLIC_URL          base URL for links in notification emails
//!
//! HTTP (admin only, mounted under `/api/admin`):
//!   GET    /filing-rules[?mailboxId=..]
//!   POST   /filing-rules          { mailboxId, senderEmail, action?, enabled?, notifyBefore? }
//!   PATCH  /filing-rules/:id      { senderEmail?, action?, enabled?, notifyBefore? }  (PUT alias)
//!   DELETE /filing-rules/:id

use std::time::Duration;

use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqliteConnection;
use velo_core::imap::scheduler::Priority;
use velo_core::ops;
use velo_core::{ImapFolder, ImapMessage};

use crate::mailboxes::{self, MailboxCreds};
use crate::notifier::{base64_url_encode, build_raw_email, html_escape};
use crate::state::{new_id, AppState};

/// The only supported action. Never delete.
pub const ACTION_MOVE_READS: &str = "move_reads";
/// Max UIDs per header fetch round-trip.
const FETCH_CHUNK: usize = 100;

// ---------- schema ----------

/// Create filing tables on the control DB.
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

    // One rule per (mailbox, sender). Best-effort: if legacy duplicate rows
    // exist the index is skipped rather than failing startup.
    if let Err(e) = sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_filing_rules_mailbox_sender \
         ON filing_rules (mailbox_id, sender_email)",
    )
    .execute(&mut *conn)
    .await
    {
        tracing::warn!("filer: could not create unique rule index: {e}");
    }

    // Keyed by mailbox id (id == mailbox_id); folder_path is the watched folder.
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

// ---------- config ----------

fn env_enabled() -> bool {
    std::env::var("VELO_FILER")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn env_secs(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

/// Spawn the filer loop when `VELO_FILER=1`. Default off.
pub fn spawn(state: AppState) {
    if !env_enabled() {
        tracing::info!("velo filer disabled (set VELO_FILER=1 to enable)");
        return;
    }
    let interval = env_secs("VELO_FILER_INTERVAL", 120).max(10);
    let delay = env_secs("VELO_FILER_NOTIFY_DELAY", 5);

    tokio::spawn(async move {
        tracing::info!("velo filer enabled — polling every {interval}s (notify→move delay {delay}s)");
        let mut tick = tokio::time::interval(Duration::from_secs(interval));
        loop {
            tick.tick().await;
            poll_once(&state, Duration::from_secs(delay)).await;
        }
    });
}

// ---------- rules ----------

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct RuleRow {
    pub id: String,
    pub user_id: Option<String>,
    pub mailbox_id: Option<String>,
    pub sender_email: Option<String>,
    pub action: String,
    pub enabled: i64,
    pub notify_before: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
struct RuleView {
    id: String,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    #[serde(rename = "mailboxId")]
    mailbox_id: Option<String>,
    #[serde(rename = "senderEmail")]
    sender_email: Option<String>,
    action: String,
    enabled: bool,
    #[serde(rename = "notifyBefore")]
    notify_before: bool,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
}

impl From<RuleRow> for RuleView {
    fn from(r: RuleRow) -> Self {
        RuleView {
            id: r.id,
            user_id: r.user_id,
            mailbox_id: r.mailbox_id,
            sender_email: r.sender_email,
            action: r.action,
            enabled: r.enabled != 0,
            notify_before: r.notify_before != 0,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// Normalize a rule sender: trimmed + lowercased. Accepts a full address
/// (`news@example.com`) or a domain wildcard (`@example.com`).
fn normalize_sender(s: &str) -> Result<String, String> {
    let s = s.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase();
    if s.is_empty() {
        return Err("senderEmail is required".into());
    }
    if s.chars().any(char::is_whitespace) {
        return Err("senderEmail must not contain spaces".into());
    }
    match s.find('@') {
        Some(i) if i == s.rfind('@').unwrap() && i + 1 < s.len() => Ok(s),
        _ => Err("senderEmail must be an address (a@b.com) or @domain".into()),
    }
}

/// Pull a bare lowercase email address out of a From header value, e.g.
/// `"News" <News@Example.com>` → `news@example.com`.
pub fn extract_address(from: &str) -> Option<String> {
    let s = from.trim();
    let inner = match (s.rfind('<'), s.rfind('>')) {
        (Some(a), Some(b)) if a < b => &s[a + 1..b],
        _ => s,
    };
    let inner = inner.trim().trim_matches('"').trim();
    if inner.contains('@') {
        Some(inner.to_lowercase())
    } else {
        None
    }
}

/// True if a rule's sender pattern matches the given (already normalized) address.
pub fn sender_matches(rule_sender: &str, address: &str) -> bool {
    let rule = rule_sender.trim().to_lowercase();
    if rule.starts_with('@') {
        address.ends_with(&rule)
    } else {
        rule == address
    }
}

/// First enabled rule matching the message's From address.
fn match_rule<'a>(rules: &'a [RuleRow], msg: &ImapMessage) -> Option<&'a RuleRow> {
    let addr = msg.from_address.as_deref().and_then(extract_address)?;
    rules.iter().find(|r| {
        r.enabled != 0
            && r.action == ACTION_MOVE_READS
            && r.sender_email.as_deref().is_some_and(|s| sender_matches(s, &addr))
    })
}

async fn enabled_rules_for(state: &AppState, mailbox_id: &str) -> Vec<RuleRow> {
    let mut control = state.control.lock().await;
    sqlx::query_as::<_, RuleRow>(
        "SELECT * FROM filing_rules WHERE mailbox_id = $1 AND enabled = 1 AND action = $2",
    )
    .bind(mailbox_id)
    .bind(ACTION_MOVE_READS)
    .fetch_all(&mut *control)
    .await
    .unwrap_or_default()
}

// ---------- Reads folder resolution ----------

/// Pick the Reads destination: top-level `Reads` first, else `INBOX<delim>Reads`.
/// Returns the raw (modified UTF-7) path to use in IMAP commands. Never creates.
pub fn resolve_reads_folder(folders: &[ImapFolder]) -> Option<String> {
    if let Some(f) = folders.iter().find(|f| f.path == "Reads" || f.raw_path == "Reads") {
        return Some(f.raw_path.clone());
    }
    folders
        .iter()
        .find(|f| {
            let d = if f.delimiter.is_empty() { "." } else { f.delimiter.as_str() };
            let want = format!("INBOX{d}Reads");
            f.path.eq_ignore_ascii_case(&want) || f.raw_path.eq_ignore_ascii_case(&want)
        })
        .map(|f| f.raw_path.clone())
}

// ---------- watermark ----------

async fn get_last_uid(state: &AppState, mailbox_id: &str) -> Option<u32> {
    let mut control = state.control.lock().await;
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT last_uid FROM filing_state WHERE id = $1")
            .bind(mailbox_id)
            .fetch_optional(&mut *control)
            .await
            .ok()
            .flatten();
    row.and_then(|(u,)| u).map(|u| u as u32)
}

async fn set_last_uid(state: &AppState, mailbox_id: &str, uid: u32, notified: bool) {
    let mut control = state.control.lock().await;
    let _ = sqlx::query(
        "INSERT INTO filing_state (id, mailbox_id, folder_path, last_uid, last_notified_at, updated_at) \
         VALUES ($1, $1, 'INBOX', $2, CASE WHEN $3 THEN unixepoch() END, unixepoch()) \
         ON CONFLICT(id) DO UPDATE SET last_uid = $2, updated_at = unixepoch(), \
         last_notified_at = CASE WHEN $3 THEN unixepoch() ELSE last_notified_at END",
    )
    .bind(mailbox_id)
    .bind(uid as i64)
    .bind(notified)
    .execute(&mut *control)
    .await;
}

// ---------- poller ----------

async fn poll_once(state: &AppState, delay: Duration) {
    let sender = mailboxes::admin_sender(state).await;
    for mb in mailboxes::all_with_creds(state).await {
        if let Err(e) = poll_mailbox(state, &mb, sender.as_ref(), delay).await {
            tracing::warn!("filer: mailbox {} failed: {e}", mb.email);
        }
    }
}

async fn poll_mailbox(
    state: &AppState,
    mb: &MailboxCreds,
    sender: Option<&MailboxCreds>,
    delay: Duration,
) -> Result<(), String> {
    let status =
        ops::imap_get_folder_status(mb.imap.clone(), "INBOX".into(), Priority::Background).await?;
    let high = status.uidnext.saturating_sub(1);

    let last = match get_last_uid(state, &mb.id).await {
        Some(u) if u <= high => u,
        Some(u) => {
            // UIDs went backwards (UIDVALIDITY reset) — re-anchor, no backfill.
            tracing::info!("filer: {} INBOX UIDs reset ({u} > {high}); re-anchoring", mb.email);
            set_last_uid(state, &mb.id, high, false).await;
            return Ok(());
        }
        None => {
            // First sight: record the high-water mark only.
            set_last_uid(state, &mb.id, high, false).await;
            return Ok(());
        }
    };
    if high <= last {
        return Ok(());
    }

    let rules = enabled_rules_for(state, &mb.id).await;
    if rules.is_empty() {
        // Nothing to file — just move the watermark forward.
        set_last_uid(state, &mb.id, high, false).await;
        return Ok(());
    }

    let new_uids =
        ops::imap_fetch_new_uids(mb.imap.clone(), "INBOX".into(), last, Priority::Background).await?;
    if new_uids.is_empty() {
        set_last_uid(state, &mb.id, high, false).await;
        return Ok(());
    }

    // Header-only fetch (BODY.PEEK — does not mark messages read).
    let mut matched: Vec<(ImapMessage, bool)> = Vec::new();
    for chunk in new_uids.chunks(FETCH_CHUNK) {
        let res = ops::imap_fetch_messages(
            mb.imap.clone(),
            "INBOX".into(),
            chunk.to_vec(),
            true,
            Priority::Background,
        )
        .await?; // transient failure: keep watermark, retry next poll
        for m in res.messages {
            if let Some(rule) = match_rule(&rules, &m) {
                matched.push((m, rule.notify_before != 0));
            }
        }
    }
    let max_uid = new_uids.iter().copied().max().unwrap_or(last).max(high);

    if matched.is_empty() {
        set_last_uid(state, &mb.id, max_uid, false).await;
        return Ok(());
    }

    let folders = ops::imap_list_folders(mb.imap.clone(), Priority::Background).await?;
    let Some(dest) = resolve_reads_folder(&folders) else {
        tracing::warn!(
            "filer: {} has {} matching message(s) but no Reads folder; skipping (create a top-level 'Reads' folder)",
            mb.email,
            matched.len()
        );
        set_last_uid(state, &mb.id, max_uid, false).await;
        return Ok(());
    };

    // Notify first.
    let owner_email = state.user_email(&mb.owner_user_id).await;
    let mut notified = false;
    for (m, _) in matched.iter().filter(|(_, notify)| *notify) {
        let (subject, from) = summary(m);
        match (sender, owner_email.as_deref()) {
            (Some(s), Some(to)) => match send_filing_notice(s, to, &mb.email, &dest, &subject, &from).await {
                Ok(()) => notified = true,
                Err(e) => tracing::warn!("filer: notify {to} failed: {e}"),
            },
            _ => tracing::info!(
                "filer: (no admin sender/owner email) would notify: {} — '{subject}' from {from} → {dest}",
                mb.email
            ),
        }
    }
    if matched.iter().any(|(_, n)| *n) && !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }

    // Then MOVE (never delete).
    let uids: Vec<u32> = matched.iter().map(|(m, _)| m.uid).collect();
    match ops::imap_move_messages(mb.imap.clone(), "INBOX".into(), uids.clone(), dest.clone(), Priority::Background).await {
        Ok(()) => tracing::info!("filer: moved {} message(s) in {} → {dest}", uids.len(), mb.email),
        // Advance anyway: retrying would re-notify every poll. Mail stays in INBOX.
        Err(e) => tracing::warn!("filer: move to {dest} failed for {}: {e}", mb.email),
    }

    set_last_uid(state, &mb.id, max_uid, notified).await;
    Ok(())
}

fn summary(m: &ImapMessage) -> (String, String) {
    let subject = m.subject.clone().unwrap_or_else(|| "(no subject)".into());
    let from = match (&m.from_name, &m.from_address) {
        (Some(n), Some(a)) => format!("{n} <{a}>"),
        (None, Some(a)) => a.clone(),
        (Some(n), None) => n.clone(),
        _ => "Unknown sender".into(),
    };
    (subject, from)
}

/// Minimal percent-encoding for a folder path inside a hash-route URL.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub(crate) fn filing_notice(
    from_addr: &str,
    to: &str,
    mailbox_email: &str,
    dest: &str,
    subject: &str,
    from: &str,
) -> String {
    let base = std::env::var("VELO_PUBLIC_URL").unwrap_or_default();
    let link = format!("{base}/#/mail/{}", encode_path_segment(dest));
    // Strip CR/LF so nothing in the subject can break out of a header line.
    let subject: String = subject.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    let subject = subject.as_str();
    let html = format!(
        "<p>A newsletter in <b>{mb}</b> is being filed to <b>{dest_h}</b>.</p>\
         <p><b>From:</b> {from_h}<br><b>Subject:</b> {subj_h}</p>\
         <p><a href=\"{link}\">Open {dest_h} in Velo</a></p>",
        mb = html_escape(mailbox_email),
        dest_h = html_escape(dest),
        from_h = html_escape(from),
        subj_h = html_escape(subject),
    );
    let text = format!(
        "Filing to {dest}\nMailbox: {mailbox_email}\nFrom: {from}\nSubject: {subject}\n\nOpen: {link}"
    );
    build_raw_email(from_addr, to, &format!("Filed to {dest}: {subject}"), &html, &text)
}

async fn send_filing_notice(
    sender: &MailboxCreds,
    to: &str,
    mailbox_email: &str,
    dest: &str,
    subject: &str,
    from: &str,
) -> Result<(), String> {
    let raw = filing_notice(&sender.email, to, mailbox_email, dest, subject, from);
    let result = ops::smtp_send_email(sender.smtp.clone(), base64_url_encode(raw.as_bytes())).await?;
    if !result.success {
        return Err(result.message);
    }
    Ok(())
}

// ---------- HTTP API (admin) ----------

pub fn admin_router(state: AppState) -> Router {
    Router::new()
        .route("/filing-rules", get(list_rules).post(create_rule))
        .route(
            "/filing-rules/:id",
            get(get_rule).patch(update_rule).put(update_rule).delete(delete_rule),
        )
        .with_state(state)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(rename = "mailboxId")]
    mailbox_id: Option<String>,
}

async fn list_rules(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Response {
    let mut control = state.control.lock().await;
    let rows = match q.mailbox_id {
        Some(mb) => {
            sqlx::query_as::<_, RuleRow>(
                "SELECT * FROM filing_rules WHERE mailbox_id = $1 ORDER BY sender_email",
            )
            .bind(mb)
            .fetch_all(&mut *control)
            .await
        }
        None => {
            sqlx::query_as::<_, RuleRow>(
                "SELECT * FROM filing_rules ORDER BY mailbox_id, sender_email",
            )
            .fetch_all(&mut *control)
            .await
        }
    }
    .unwrap_or_default();
    Json(rows.into_iter().map(RuleView::from).collect::<Vec<_>>()).into_response()
}

async fn fetch_rule(conn: &mut SqliteConnection, id: &str) -> Option<RuleRow> {
    sqlx::query_as::<_, RuleRow>("SELECT * FROM filing_rules WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .ok()
        .flatten()
}

async fn get_rule(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut control = state.control.lock().await;
    match fetch_rule(&mut control, &id).await {
        Some(r) => Json(RuleView::from(r)).into_response(),
        None => err(StatusCode::NOT_FOUND, "Rule not found"),
    }
}

fn validate_action(a: Option<&str>) -> Result<(), Response> {
    match a {
        None => Ok(()),
        Some(ACTION_MOVE_READS) => Ok(()),
        Some(other) => Err(err(
            StatusCode::BAD_REQUEST,
            format!("Unsupported action '{other}' (only '{ACTION_MOVE_READS}')"),
        )),
    }
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.to_string().contains("UNIQUE")
}

#[derive(Deserialize)]
struct CreateRule {
    #[serde(rename = "mailboxId")]
    mailbox_id: String,
    #[serde(rename = "senderEmail")]
    sender_email: String,
    action: Option<String>,
    enabled: Option<bool>,
    #[serde(rename = "notifyBefore")]
    notify_before: Option<bool>,
}

async fn create_rule(State(state): State<AppState>, Json(req): Json<CreateRule>) -> Response {
    if let Err(r) = validate_action(req.action.as_deref()) {
        return r;
    }
    let sender = match normalize_sender(&req.sender_email) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let mut control = state.control.lock().await;
    let owner: Option<(String,)> =
        sqlx::query_as("SELECT owner_user_id FROM mailboxes WHERE id = $1")
            .bind(&req.mailbox_id)
            .fetch_optional(&mut *control)
            .await
            .ok()
            .flatten();
    let Some((owner,)) = owner else {
        return err(StatusCode::NOT_FOUND, "Mailbox not found");
    };

    let id = new_id();
    let res = sqlx::query(
        "INSERT INTO filing_rules (id, user_id, mailbox_id, sender_email, action, enabled, notify_before) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&req.mailbox_id)
    .bind(&sender)
    .bind(ACTION_MOVE_READS)
    .bind(req.enabled.unwrap_or(true) as i64)
    .bind(req.notify_before.unwrap_or(true) as i64)
    .execute(&mut *control)
    .await;
    match res {
        Ok(_) => match fetch_rule(&mut control, &id).await {
            Some(r) => (StatusCode::CREATED, Json(RuleView::from(r))).into_response(),
            None => err(StatusCode::INTERNAL_SERVER_ERROR, "Rule vanished after insert"),
        },
        Err(e) if is_unique_violation(&e) => {
            err(StatusCode::CONFLICT, "A rule for this sender already exists on this mailbox")
        }
        Err(e) => err(StatusCode::BAD_REQUEST, format!("Failed to create rule: {e}")),
    }
}

#[derive(Deserialize)]
struct UpdateRule {
    #[serde(rename = "senderEmail")]
    sender_email: Option<String>,
    action: Option<String>,
    enabled: Option<bool>,
    #[serde(rename = "notifyBefore")]
    notify_before: Option<bool>,
}

async fn update_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateRule>,
) -> Response {
    if let Err(r) = validate_action(req.action.as_deref()) {
        return r;
    }
    let sender = match req.sender_email.as_deref().map(normalize_sender).transpose() {
        Ok(s) => s,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let mut control = state.control.lock().await;
    let Some(existing) = fetch_rule(&mut control, &id).await else {
        return err(StatusCode::NOT_FOUND, "Rule not found");
    };
    let res = sqlx::query(
        "UPDATE filing_rules SET sender_email = $2, enabled = $3, notify_before = $4, \
         updated_at = unixepoch() WHERE id = $1",
    )
    .bind(&id)
    .bind(sender.or(existing.sender_email))
    .bind(req.enabled.map(|b| b as i64).unwrap_or(existing.enabled))
    .bind(req.notify_before.map(|b| b as i64).unwrap_or(existing.notify_before))
    .execute(&mut *control)
    .await;
    match res {
        Ok(_) => match fetch_rule(&mut control, &id).await {
            Some(r) => Json(RuleView::from(r)).into_response(),
            None => err(StatusCode::NOT_FOUND, "Rule not found"),
        },
        Err(e) if is_unique_violation(&e) => {
            err(StatusCode::CONFLICT, "A rule for this sender already exists on this mailbox")
        }
        Err(e) => err(StatusCode::BAD_REQUEST, format!("Failed to update rule: {e}")),
    }
}

async fn delete_rule(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut control = state.control.lock().await;
    let res = sqlx::query("DELETE FROM filing_rules WHERE id = $1")
        .bind(&id)
        .execute(&mut *control)
        .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => Json(json!({ "ok": true })).into_response(),
        Ok(_) => err(StatusCode::NOT_FOUND, "Rule not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(path: &str, delim: &str) -> ImapFolder {
        ImapFolder {
            path: path.into(),
            raw_path: path.into(),
            name: path.rsplit(delim).next().unwrap().into(),
            delimiter: delim.into(),
            special_use: None,
            exists: 0,
            unseen: 0,
        }
    }

    #[test]
    fn prefers_top_level_reads() {
        let fs = vec![folder("INBOX", "."), folder("INBOX.Reads", "."), folder("Reads", ".")];
        assert_eq!(resolve_reads_folder(&fs).as_deref(), Some("Reads"));
    }

    #[test]
    fn falls_back_to_inbox_reads() {
        let fs = vec![folder("INBOX", "."), folder("INBOX.Reads", ".")];
        assert_eq!(resolve_reads_folder(&fs).as_deref(), Some("INBOX.Reads"));
        let fs = vec![folder("INBOX", "/"), folder("INBOX/Reads", "/")];
        assert_eq!(resolve_reads_folder(&fs).as_deref(), Some("INBOX/Reads"));
    }

    #[test]
    fn no_reads_folder_means_none() {
        let fs = vec![folder("INBOX", "."), folder("Archive.Reads", "."), folder("reads2", ".")];
        assert_eq!(resolve_reads_folder(&fs), None);
    }

    #[test]
    fn extracts_address_from_from_header() {
        assert_eq!(extract_address("\"News\" <News@Example.com>").as_deref(), Some("news@example.com"));
        assert_eq!(extract_address("  Plain@Ex.com ").as_deref(), Some("plain@ex.com"));
        assert_eq!(extract_address("No Address"), None);
    }

    #[test]
    fn sender_matching_is_case_insensitive_with_domain_wildcard() {
        assert!(sender_matches("News@Example.com", "news@example.com"));
        assert!(!sender_matches("news@example.com", "other@example.com"));
        assert!(sender_matches("@substack.com", "writer@substack.com"));
        assert!(!sender_matches("@substack.com", "writer@notsubstack.org"));
    }

    #[test]
    fn normalize_sender_validates() {
        assert_eq!(normalize_sender(" <News@Ex.COM> ").unwrap(), "news@ex.com");
        assert_eq!(normalize_sender("@Ex.com").unwrap(), "@ex.com");
        assert!(normalize_sender("").is_err());
        assert!(normalize_sender("noat").is_err());
        assert!(normalize_sender("a@b@c").is_err());
        assert!(normalize_sender("a @b.com").is_err());
        assert!(normalize_sender("a@").is_err());
    }

    #[test]
    fn match_rule_respects_enabled_flag() {
        let rule = |sender: &str, enabled: i64| RuleRow {
            id: "r".into(),
            user_id: None,
            mailbox_id: Some("m".into()),
            sender_email: Some(sender.into()),
            action: ACTION_MOVE_READS.into(),
            enabled,
            notify_before: 1,
            created_at: 0,
            updated_at: 0,
        };
        let msg: ImapMessage = serde_json::from_value(json!({
            "uid": 7, "folder": "INBOX", "message_id": null, "in_reply_to": null,
            "references": null, "from_address": "Letters@Ex.com", "from_name": "Letters",
            "to_addresses": null, "cc_addresses": null, "bcc_addresses": null,
            "reply_to": null, "subject": "Issue 1", "date": 0, "is_read": false,
            "is_starred": false, "is_draft": false, "body_html": null, "body_text": null,
            "snippet": null, "raw_size": 0, "list_unsubscribe": null,
            "list_unsubscribe_post": null, "auth_results": null, "attachments": []
        }))
        .unwrap();
        assert!(match_rule(&[rule("letters@ex.com", 0)], &msg).is_none());
        assert!(match_rule(&[rule("letters@ex.com", 1)], &msg).is_some());
        assert!(match_rule(&[rule("other@ex.com", 1)], &msg).is_none());
    }

    #[test]
    fn notice_is_single_line_subject_and_escaped() {
        let raw = filing_notice("admin@ex.com", "me@ex.com", "me@ex.com", "Reads", "Hi\r\nBcc: x@y", "<b>x</b>");
        assert!(raw.contains("Subject: Filed to Reads: HiBcc: x@y\r\n"));
        assert!(!raw.contains("\r\nBcc:"));
        assert!(raw.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(raw.contains("/#/mail/Reads"));
    }

    #[tokio::test]
    async fn watermark_roundtrip() {
        let dir = std::env::temp_dir().join(format!("velo-filer-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState::init(dir.join("c.db").to_str().unwrap(), dir.clone()).await;
        assert_eq!(get_last_uid(&state, "mb1").await, None);
        set_last_uid(&state, "mb1", 10, false).await;
        assert_eq!(get_last_uid(&state, "mb1").await, Some(10));
        set_last_uid(&state, "mb1", 42, true).await;
        assert_eq!(get_last_uid(&state, "mb1").await, Some(42));
        let mut c = state.control.lock().await;
        let (n, notified): (i64, Option<i64>) = sqlx::query_as(
            "SELECT COUNT(*), MAX(last_notified_at) FROM filing_state WHERE mailbox_id = 'mb1'",
        )
        .fetch_one(&mut *c)
        .await
        .unwrap();
        assert_eq!(n, 1);
        assert!(notified.is_some());
    }
}
