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
//! - **No delete**: actions only ever move mail. `move_reads` (IMAP MOVE
//!   to Reads) and `move` (to `destFolder`, optionally in another mailbox
//!   `destMailboxId`). A cross-mailbox `move` is an Apple-Mail style transfer
//!   (see `transfer.rs`): fetch → APPEND to the destination → only then
//!   `\Deleted` + `UID EXPUNGE` of that one source UID. Never forwarded.
//! - **Catch-all** (`senderEmail = "*"`, API `matchAll: true`): opt-in only,
//!   `move` action only, created disabled unless `enabled: true` is passed.
//!   Specific sender rules always win over the catch-all. Backfill ignores
//!   catch-alls unless `?includeCatchAll=true`.
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
//!   POST   /filing-rules          { mailboxId, senderEmail? | matchAll: true, action?,
//!                                   destMailbox? (id or email), destFolder?, enabled?, notifyBefore? }
//!   PATCH  /filing-rules/:id      { senderEmail?, action?, destMailbox?, destFolder?, enabled?, notifyBefore? }  (PUT alias)
//!   DELETE /filing-rules/:id
//!   POST   /filing-backfill/:mailboxId[?includeCatchAll=true]

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

/// MOVE to the mailbox's Reads folder. Never delete.
pub const ACTION_MOVE_READS: &str = "move_reads";
/// MOVE to `dest_folder`, in `dest_mailbox_id` when set (cross-mailbox
/// transfer) or the rule's own mailbox otherwise.
pub const ACTION_MOVE: &str = "move";
/// `sender_email` value of a catch-all rule (matches every new message).
pub const CATCH_ALL: &str = "*";
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

    // Destination columns (added later; NULL for legacy move_reads rules).
    for col in ["dest_mailbox_id TEXT", "dest_folder TEXT"] {
        let _ = sqlx::query(&format!("ALTER TABLE filing_rules ADD COLUMN {col}"))
            .execute(&mut *conn)
            .await; // "duplicate column" on later startups is expected
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
    #[sqlx(default)]
    pub dest_mailbox_id: Option<String>,
    #[sqlx(default)]
    pub dest_folder: Option<String>,
}

impl RuleRow {
    pub fn is_catch_all(&self) -> bool {
        self.sender_email.as_deref() == Some(CATCH_ALL)
    }
    fn is_active(&self) -> bool {
        self.enabled != 0 && (self.action == ACTION_MOVE_READS || self.action == ACTION_MOVE)
    }
    /// Where a matching message goes.
    fn target(&self) -> Option<Target> {
        match self.action.as_str() {
            ACTION_MOVE_READS => Some(Target::Reads),
            ACTION_MOVE => {
                let folder = self.dest_folder.clone().filter(|f| !f.trim().is_empty())?;
                match self.dest_mailbox_id.as_deref() {
                    Some(d) if Some(d) != self.mailbox_id.as_deref() => {
                        Some(Target::Mailbox { id: d.to_string(), folder })
                    }
                    _ => Some(Target::Folder(folder)),
                }
            }
            _ => None,
        }
    }
}

/// Destination of a matched message.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Target {
    Reads,
    /// A folder in the same mailbox (IMAP MOVE).
    Folder(String),
    /// A folder in another provisioned mailbox (transfer).
    Mailbox { id: String, folder: String },
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
    #[serde(rename = "destMailboxId")]
    dest_mailbox_id: Option<String>,
    #[serde(rename = "destFolder")]
    dest_folder: Option<String>,
    #[serde(rename = "matchAll")]
    match_all: bool,
}

impl From<RuleRow> for RuleView {
    fn from(r: RuleRow) -> Self {
        let match_all = r.is_catch_all();
        RuleView {
            match_all,
            dest_mailbox_id: r.dest_mailbox_id,
            dest_folder: r.dest_folder,
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
pub(crate) fn normalize_sender(s: &str) -> Result<String, String> {
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

/// First enabled rule matching the message. Specific sender rules (exact
/// address beats @domain) take priority; the catch-all only applies when no
/// sender rule matched.
fn match_rule<'a>(rules: &'a [RuleRow], msg: &ImapMessage) -> Option<&'a RuleRow> {
    let active = || rules.iter().filter(|r| r.is_active());
    if let Some(addr) = msg.from_address.as_deref().and_then(extract_address) {
        let hit = |want_domain: bool| {
            active().find(|r| {
                !r.is_catch_all()
                    && r.sender_email.as_deref().is_some_and(|s| {
                        s.starts_with('@') == want_domain && sender_matches(s, &addr)
                    })
            })
        };
        if let Some(r) = hit(false).or_else(|| hit(true)) {
            return Some(r);
        }
    }
    active().find(|r| r.is_catch_all() && r.action == ACTION_MOVE)
}

async fn enabled_rules_for(state: &AppState, mailbox_id: &str) -> Vec<RuleRow> {
    let mut control = state.control.lock().await;
    sqlx::query_as::<_, RuleRow>(
        "SELECT * FROM filing_rules WHERE mailbox_id = $1 AND enabled = 1 AND action IN ($2, $3)",
    )
    .bind(mailbox_id)
    .bind(ACTION_MOVE_READS)
    .bind(ACTION_MOVE)
    .fetch_all(&mut *control)
    .await
    .unwrap_or_default()
}

/// Resolve a configured folder name to the server's raw path. Exact match on
/// display or raw path; `INBOX` is case-insensitive. Never creates.
pub fn resolve_folder(folders: &[ImapFolder], name: &str) -> Option<String> {
    let name = name.trim();
    folders
        .iter()
        .find(|f| f.path == name || f.raw_path == name)
        .or_else(|| {
            name.eq_ignore_ascii_case("INBOX")
                .then(|| folders.iter().find(|f| f.raw_path.eq_ignore_ascii_case("INBOX")))
                .flatten()
        })
        .map(|f| f.raw_path.clone())
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
    let mut reads: Vec<(ImapMessage, bool)> = Vec::new();
    let mut groups: MoveGroups = Default::default();
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
                match rule.target() {
                    Some(Target::Reads) => reads.push((m, rule.notify_before != 0)),
                    Some(t) => groups.entry(t).or_default().push(m.uid),
                    None => {}
                }
            }
        }
    }
    let max_uid = new_uids.iter().copied().max().unwrap_or(last).max(high);

    let notified = if reads.is_empty() {
        false
    } else {
        file_reads(state, mb, sender, delay, &reads).await?
    };
    if !groups.is_empty() {
        // Advance regardless (like Reads): the transfer journal + Message-ID
        // dedupe make a later backfill retry safe.
        let summary = apply_moves(state, mb, groups).await;
        tracing::info!("filer: {} rule moves {summary}", mb.email);
    }

    set_last_uid(state, &mb.id, max_uid, notified).await;
    Ok(())
}

/// Matched UIDs grouped by destination (sorted for stable processing).
type MoveGroups = std::collections::BTreeMap<Target, Vec<u32>>;

/// Notify (if configured) then MOVE matches to Reads. Returns whether a
/// notice was sent.
async fn file_reads(
    state: &AppState,
    mb: &MailboxCreds,
    sender: Option<&MailboxCreds>,
    delay: Duration,
    matched: &[(ImapMessage, bool)],
) -> Result<bool, String> {
    let folders = ops::imap_list_folders(mb.imap.clone(), Priority::Background).await?;
    let Some(dest) = resolve_reads_folder(&folders) else {
        tracing::warn!(
            "filer: {} has {} matching message(s) but no Reads folder; skipping (create a top-level 'Reads' folder)",
            mb.email,
            matched.len()
        );
        return Ok(false);
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
    Ok(notified)
}

/// Execute `move` rule groups from `mb`'s INBOX. Same-mailbox targets use IMAP
/// MOVE; other-mailbox targets use the APPEND-then-delete transfer. Missing
/// destination folders are skipped (never created). Never sends notices.
async fn apply_moves(state: &AppState, mb: &MailboxCreds, groups: MoveGroups) -> serde_json::Value {
    let mut results = Vec::new();
    let mut own_folders: Option<Vec<ImapFolder>> = None;
    let all = mailboxes::all_with_creds(state).await;
    for (target, uids) in groups {
        let r = match &target {
            Target::Reads => continue, // handled by file_reads
            Target::Folder(name) => {
                if own_folders.is_none() {
                    match ops::imap_list_folders(mb.imap.clone(), Priority::Background).await {
                        Ok(f) => own_folders = Some(f),
                        Err(e) => {
                            results.push(json!({ "folder": name, "error": e }));
                            continue;
                        }
                    }
                }
                match resolve_folder(own_folders.as_deref().unwrap_or_default(), name) {
                    None => Err(format!("folder '{name}' not found in {} (not created)", mb.email)),
                    Some(raw) => {
                        let mut moved = 0usize;
                        let mut res = Ok(());
                        for chunk in uids.chunks(FETCH_CHUNK) {
                            if let Err(e) = ops::imap_move_messages(mb.imap.clone(), "INBOX".into(), chunk.to_vec(), raw.clone(), Priority::Background).await {
                                res = Err(e);
                                break;
                            }
                            moved += chunk.len();
                        }
                        res.map(|_| json!({ "folder": raw, "moved": moved }))
                    }
                }
            }
            Target::Mailbox { id, folder } => match all.iter().find(|m| &m.id == id) {
                None => Err(format!("destination mailbox {id} not found")),
                Some(dest) => match ops::imap_list_folders(dest.imap.clone(), Priority::Background).await {
                    Err(e) => Err(e),
                    Ok(dfolders) => match resolve_folder(&dfolders, folder) {
                        None => Err(format!("folder '{folder}' not found in {} (not created)", dest.email)),
                        Some(raw) => crate::transfer::transfer_messages(state, mb, "INBOX", &uids, dest, &raw)
                            .await
                            .map(|o| json!({ "destMailbox": dest.email, "folder": raw, "result": o })),
                    },
                },
            },
        };
        match r {
            Ok(v) => results.push(v),
            Err(e) => {
                tracing::warn!("filer: {} → {:?} failed: {e}", mb.email, target);
                results.push(json!({ "target": format!("{target:?}"), "error": e, "uids": uids.len() }));
            }
        }
    }
    json!(results)
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

// ---------- one-time backfill ----------

/// Apply the mailbox's enabled rules to EVERYTHING currently in INBOX (not just
/// mail past the watermark). Reads matches are MOVEd to Reads; `move` matches
/// go to their destination (cross-mailbox via transfer). No notifications.
/// Catch-all rules are skipped unless `include_catch_all`. Returns counts.
pub async fn backfill_mailbox(
    state: &AppState,
    mailbox_id: &str,
    include_catch_all: bool,
) -> Result<serde_json::Value, String> {
    let mb = mailboxes::all_with_creds(state)
        .await
        .into_iter()
        .find(|m| m.id == mailbox_id)
        .ok_or("Mailbox not found")?;
    let rules: Vec<RuleRow> = enabled_rules_for(state, &mb.id)
        .await
        .into_iter()
        .filter(|r| include_catch_all || !r.is_catch_all())
        .collect();
    if rules.is_empty() {
        return Ok(json!({ "moved": 0, "scanned": 0, "bySender": {} }));
    }
    let uids = ops::imap_search_all_uids(mb.imap.clone(), "INBOX".into(), Priority::Background).await?;
    let mut by_sender: std::collections::BTreeMap<String, u32> = Default::default();
    let mut reads: Vec<u32> = Vec::new();
    let mut groups: MoveGroups = Default::default();
    for chunk in uids.chunks(FETCH_CHUNK) {
        let res = ops::imap_fetch_messages(mb.imap.clone(), "INBOX".into(), chunk.to_vec(), true, Priority::Background).await?;
        for m in res.messages {
            let Some(rule) = match_rule(&rules, &m) else { continue };
            let a = m.from_address.as_deref().and_then(extract_address).unwrap_or_default();
            *by_sender.entry(a).or_default() += 1;
            match rule.target() {
                Some(Target::Reads) => reads.push(m.uid),
                Some(t) => groups.entry(t).or_default().push(m.uid),
                None => {}
            }
        }
    }
    let mut moved = 0usize;
    let mut dest = None;
    if !reads.is_empty() {
        let folders = ops::imap_list_folders(mb.imap.clone(), Priority::Background).await?;
        let d = resolve_reads_folder(&folders).ok_or("No Reads folder (create a top-level 'Reads')")?;
        for chunk in reads.chunks(FETCH_CHUNK) {
            ops::imap_move_messages(mb.imap.clone(), "INBOX".into(), chunk.to_vec(), d.clone(), Priority::Background).await?;
            moved += chunk.len();
        }
        dest = Some(d);
    }
    let rule_moves = if groups.is_empty() { json!([]) } else { apply_moves(state, &mb, groups).await };
    tracing::info!("filer: backfill {} scanned {} moved {moved} → {dest:?} {:?} rule moves {rule_moves}", mb.email, uids.len(), by_sender);
    Ok(json!({
        "mailbox": mb.email, "dest": dest, "scanned": uids.len(), "moved": moved,
        "bySender": by_sender, "ruleMoves": rule_moves, "includeCatchAll": include_catch_all
    }))
}

#[derive(Deserialize)]
struct BackfillQuery {
    #[serde(rename = "includeCatchAll", default)]
    include_catch_all: bool,
}

async fn backfill_endpoint(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<BackfillQuery>,
) -> Response {
    match backfill_mailbox(&state, &id, q.include_catch_all).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

// ---------- HTTP API (admin) ----------

pub fn admin_router(state: AppState) -> Router {
    Router::new()
        .route("/filing-rules", get(list_rules).post(create_rule))
        .route("/filing-backfill/:mailbox_id", axum::routing::post(backfill_endpoint))
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
        None | Some(ACTION_MOVE_READS) | Some(ACTION_MOVE) => Ok(()),
        Some(other) => Err(err(
            StatusCode::BAD_REQUEST,
            format!("Unsupported action '{other}' (use '{ACTION_MOVE_READS}' or '{ACTION_MOVE}')"),
        )),
    }
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.to_string().contains("UNIQUE")
}

/// The fully-resolved shape of a rule, validated before insert/update.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RuleSpec {
    pub mailbox_id: String,
    pub sender: String,
    pub action: String,
    pub dest_mailbox_id: Option<String>,
    pub dest_folder: Option<String>,
}

/// Pure validation of a rule's shape (no DB).
pub(crate) fn validate_spec(r: &RuleSpec) -> Result<(), String> {
    let catch_all = r.sender == CATCH_ALL;
    match r.action.as_str() {
        ACTION_MOVE_READS => {
            if catch_all {
                return Err("A catch-all rule must use action 'move' with a destFolder".into());
            }
            if r.dest_mailbox_id.is_some() || r.dest_folder.is_some() {
                return Err("destMailbox/destFolder require action 'move'".into());
            }
        }
        ACTION_MOVE => {
            let Some(f) = r.dest_folder.as_deref() else {
                return Err("action 'move' requires destFolder".into());
            };
            if f.trim().is_empty() || f.contains(['\r', '\n', '\0']) {
                return Err("destFolder is invalid".into());
            }
            let same = r.dest_mailbox_id.as_deref().map_or(true, |d| d == r.mailbox_id);
            if same && f.trim().eq_ignore_ascii_case("INBOX") {
                return Err("Moving INBOX to its own INBOX does nothing".into());
            }
        }
        other => return Err(format!("Unsupported action '{other}'")),
    }
    Ok(())
}

/// Resolve `destMailbox` (id or email) to a mailbox id.
async fn resolve_mailbox(conn: &mut SqliteConnection, key: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>(
        "SELECT id FROM mailboxes WHERE id = $1 OR lower(email) = lower($1) LIMIT 1",
    )
    .bind(key.trim())
    .fetch_optional(conn)
    .await
    .ok()
    .flatten()
    .map(|(id,)| id)
}

/// Reject A→B(INBOX) when B already sends the same senders back to A's INBOX
/// (either side catch-all, or the same sender) — that would ping-pong mail.
async fn check_no_loop(conn: &mut SqliteConnection, r: &RuleSpec, self_id: Option<&str>) -> Result<(), String> {
    let (Some(dest), Some(folder)) = (r.dest_mailbox_id.as_deref(), r.dest_folder.as_deref()) else {
        return Ok(());
    };
    if dest == r.mailbox_id || !folder.trim().eq_ignore_ascii_case("INBOX") {
        return Ok(());
    }
    let back: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM filing_rules WHERE mailbox_id = $1 AND dest_mailbox_id = $2 AND action = $3 \
         AND upper(trim(dest_folder)) = 'INBOX' AND (sender_email = $4 OR sender_email = $5 OR $4 = $5) \
         AND id IS NOT $6 LIMIT 1",
    )
    .bind(dest)
    .bind(&r.mailbox_id)
    .bind(ACTION_MOVE)
    .bind(&r.sender)
    .bind(CATCH_ALL)
    .bind(self_id)
    .fetch_optional(&mut *conn)
    .await
    .ok()
    .flatten();
    match back {
        Some((id,)) => Err(format!("Rule {id} already moves this mail back from the destination INBOX; this would loop")),
        None => Ok(()),
    }
}

#[derive(Deserialize)]
struct CreateRule {
    #[serde(rename = "mailboxId")]
    mailbox_id: String,
    #[serde(rename = "senderEmail")]
    sender_email: Option<String>,
    /// Opt-in catch-all: must be exactly `true`; matches all new INBOX mail.
    #[serde(rename = "matchAll", default)]
    match_all: bool,
    action: Option<String>,
    /// Destination mailbox id or email (cross-mailbox move). Omit for same mailbox.
    #[serde(rename = "destMailbox")]
    dest_mailbox: Option<String>,
    #[serde(rename = "destFolder")]
    dest_folder: Option<String>,
    enabled: Option<bool>,
    #[serde(rename = "notifyBefore")]
    notify_before: Option<bool>,
}

/// Sender for a create request: `"*"` only via `matchAll: true`.
fn create_sender(req_sender: Option<&str>, match_all: bool) -> Result<String, String> {
    match (match_all, req_sender.map(str::trim)) {
        (true, None) | (true, Some(CATCH_ALL)) => Ok(CATCH_ALL.into()),
        (true, Some(_)) => Err("matchAll: true cannot be combined with a senderEmail".into()),
        (false, Some(CATCH_ALL)) => Err("Use matchAll: true for a catch-all rule".into()),
        (false, Some(s)) => normalize_sender(s),
        (false, None) => Err("senderEmail is required (or matchAll: true)".into()),
    }
}

async fn create_rule(State(state): State<AppState>, Json(req): Json<CreateRule>) -> Response {
    if let Err(r) = validate_action(req.action.as_deref()) {
        return r;
    }
    let sender = match create_sender(req.sender_email.as_deref(), req.match_all) {
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
    let dest_mailbox_id = match req.dest_mailbox.as_deref().filter(|d| !d.trim().is_empty()) {
        None => None,
        Some(key) => match resolve_mailbox(&mut control, key).await {
            Some(id) => Some(id),
            None => return err(StatusCode::NOT_FOUND, "Destination mailbox not found"),
        },
    };
    let dest_folder = req.dest_folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    // A destination implies `move` unless an action was given explicitly.
    let action = req.action.clone().unwrap_or_else(|| {
        if dest_folder.is_some() || dest_mailbox_id.is_some() || sender == CATCH_ALL {
            ACTION_MOVE.into()
        } else {
            ACTION_MOVE_READS.into()
        }
    });
    let spec = RuleSpec { mailbox_id: req.mailbox_id.clone(), sender, action, dest_mailbox_id, dest_folder };
    if let Err(e) = validate_spec(&spec) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    if let Err(e) = check_no_loop(&mut control, &spec, None).await {
        return err(StatusCode::CONFLICT, e);
    }
    // Catch-alls start disabled unless `enabled: true` is explicit; `move`
    // rules never send filing notices.
    let enabled = req.enabled.unwrap_or(spec.sender != CATCH_ALL);
    let notify = spec.action == ACTION_MOVE_READS && req.notify_before.unwrap_or(true);

    let id = new_id();
    let res = sqlx::query(
        "INSERT INTO filing_rules (id, user_id, mailbox_id, sender_email, action, enabled, notify_before, dest_mailbox_id, dest_folder) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(&id)
    .bind(&owner)
    .bind(&spec.mailbox_id)
    .bind(&spec.sender)
    .bind(&spec.action)
    .bind(enabled as i64)
    .bind(notify as i64)
    .bind(&spec.dest_mailbox_id)
    .bind(&spec.dest_folder)
    .execute(&mut *control)
    .await;
    match res {
        Ok(_) => match fetch_rule(&mut control, &id).await {
            Some(r) => (StatusCode::CREATED, Json(RuleView::from(r))).into_response(),
            None => err(StatusCode::INTERNAL_SERVER_ERROR, "Rule vanished after insert"),
        },
        Err(e) if is_unique_violation(&e) => err(
            StatusCode::CONFLICT,
            if spec.sender == CATCH_ALL {
                "This mailbox already has a catch-all rule"
            } else {
                "A rule for this sender already exists on this mailbox"
            },
        ),
        Err(e) => err(StatusCode::BAD_REQUEST, format!("Failed to create rule: {e}")),
    }
}

#[derive(Deserialize)]
struct UpdateRule {
    #[serde(rename = "senderEmail")]
    sender_email: Option<String>,
    action: Option<String>,
    /// Id or email; `""` clears it (back to same-mailbox).
    #[serde(rename = "destMailbox")]
    dest_mailbox: Option<String>,
    /// `""` clears it.
    #[serde(rename = "destFolder")]
    dest_folder: Option<String>,
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
    if existing.is_catch_all() && sender.is_some() {
        return err(StatusCode::BAD_REQUEST, "A catch-all rule's sender can't be changed; delete it and create a sender rule");
    }
    let dest_mailbox_id = match req.dest_mailbox.as_deref().map(str::trim) {
        None => existing.dest_mailbox_id.clone(),
        Some("") => None,
        Some(key) => match resolve_mailbox(&mut control, key).await {
            Some(id) => Some(id),
            None => return err(StatusCode::NOT_FOUND, "Destination mailbox not found"),
        },
    };
    let dest_folder = match req.dest_folder.as_deref().map(str::trim) {
        None => existing.dest_folder.clone(),
        Some("") => None,
        Some(f) => Some(f.to_string()),
    };
    let spec = RuleSpec {
        mailbox_id: existing.mailbox_id.clone().unwrap_or_default(),
        sender: sender.clone().or(existing.sender_email.clone()).unwrap_or_default(),
        action: req.action.clone().unwrap_or(existing.action.clone()),
        dest_mailbox_id,
        dest_folder,
    };
    if let Err(e) = validate_spec(&spec) {
        return err(StatusCode::BAD_REQUEST, e);
    }
    if let Err(e) = check_no_loop(&mut control, &spec, Some(&id)).await {
        return err(StatusCode::CONFLICT, e);
    }
    let notify = spec.action == ACTION_MOVE_READS
        && req.notify_before.map(|b| b as i64).unwrap_or(existing.notify_before) != 0;
    let res = sqlx::query(
        "UPDATE filing_rules SET sender_email = $2, enabled = $3, notify_before = $4, action = $5, \
         dest_mailbox_id = $6, dest_folder = $7, updated_at = unixepoch() WHERE id = $1",
    )
    .bind(&id)
    .bind(&spec.sender)
    .bind(req.enabled.map(|b| b as i64).unwrap_or(existing.enabled))
    .bind(notify as i64)
    .bind(&spec.action)
    .bind(&spec.dest_mailbox_id)
    .bind(&spec.dest_folder)
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
            dest_mailbox_id: None,
            dest_folder: None,
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

    fn mrule(id: &str, sender: &str, action: &str, dest_mb: Option<&str>, dest_folder: Option<&str>) -> RuleRow {
        RuleRow {
            id: id.into(),
            user_id: None,
            mailbox_id: Some("src".into()),
            sender_email: Some(sender.into()),
            action: action.into(),
            enabled: 1,
            notify_before: 0,
            created_at: 0,
            updated_at: 0,
            dest_mailbox_id: dest_mb.map(Into::into),
            dest_folder: dest_folder.map(Into::into),
        }
    }

    fn from_msg(from: Option<&str>) -> ImapMessage {
        serde_json::from_value(json!({
            "uid": 3, "folder": "INBOX", "from_address": from, "subject": "s",
            "date": 0, "is_read": false, "is_starred": false, "is_draft": false, "raw_size": 0, "attachments": []
        }))
        .unwrap()
    }

    #[test]
    fn specific_rules_beat_catch_all() {
        let rules = vec![
            mrule("all", CATCH_ALL, ACTION_MOVE, Some("me"), Some("INBOX")),
            mrule("dom", "@news.com", ACTION_MOVE_READS, None, None),
            mrule("exact", "boss@news.com", ACTION_MOVE, None, Some("Clients")),
        ];
        let id = |m: &ImapMessage| match_rule(&rules, m).map(|r| r.id.clone());
        assert_eq!(id(&from_msg(Some("Boss@News.com"))).as_deref(), Some("exact"));
        assert_eq!(id(&from_msg(Some("letters@news.com"))).as_deref(), Some("dom"));
        assert_eq!(id(&from_msg(Some("anyone@else.org"))).as_deref(), Some("all"));
        // No From at all still hits the catch-all.
        assert_eq!(id(&from_msg(None)).as_deref(), Some("all"));
    }

    #[test]
    fn disabled_catch_all_matches_nothing() {
        let mut all = mrule("all", CATCH_ALL, ACTION_MOVE, Some("me"), Some("INBOX"));
        all.enabled = 0;
        assert!(match_rule(&[all], &from_msg(Some("a@b.com"))).is_none());
        // A catch-all on move_reads (invalid shape) is never applied.
        let bad = mrule("x", CATCH_ALL, ACTION_MOVE_READS, None, None);
        assert!(match_rule(&[bad], &from_msg(Some("a@b.com"))).is_none());
    }

    #[test]
    fn rule_targets() {
        assert_eq!(mrule("a", "x@y.com", ACTION_MOVE_READS, None, None).target(), Some(Target::Reads));
        assert_eq!(
            mrule("b", "x@y.com", ACTION_MOVE, None, Some("Clients")).target(),
            Some(Target::Folder("Clients".into()))
        );
        // Destination equal to own mailbox is a plain MOVE.
        assert_eq!(
            mrule("c", "x@y.com", ACTION_MOVE, Some("src"), Some("Clients")).target(),
            Some(Target::Folder("Clients".into()))
        );
        assert_eq!(
            mrule("d", "x@y.com", ACTION_MOVE, Some("me"), Some("INBOX")).target(),
            Some(Target::Mailbox { id: "me".into(), folder: "INBOX".into() })
        );
        assert_eq!(mrule("e", "x@y.com", ACTION_MOVE, Some("me"), None).target(), None);
    }

    #[test]
    fn spec_validation() {
        let spec = |sender: &str, action: &str, dm: Option<&str>, df: Option<&str>| RuleSpec {
            mailbox_id: "src".into(),
            sender: sender.into(),
            action: action.into(),
            dest_mailbox_id: dm.map(Into::into),
            dest_folder: df.map(Into::into),
        };
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE_READS, None, None)).is_ok());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, Some("me"), Some("INBOX"))).is_ok());
        assert!(validate_spec(&spec(CATCH_ALL, ACTION_MOVE, Some("me"), Some("INBOX"))).is_ok());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, None, Some("Clients"))).is_ok());
        assert!(validate_spec(&spec(CATCH_ALL, ACTION_MOVE_READS, None, None)).is_err());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE_READS, Some("me"), None)).is_err());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, Some("me"), None)).is_err());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, None, Some("inbox"))).is_err());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, Some("src"), Some("INBOX"))).is_err());
        assert!(validate_spec(&spec("a@b.com", ACTION_MOVE, Some("me"), Some("A\r\nB"))).is_err());
        assert!(validate_spec(&spec("a@b.com", "delete", None, None)).is_err());
    }

    #[test]
    fn catch_all_is_explicit_opt_in() {
        assert_eq!(create_sender(None, true).unwrap(), CATCH_ALL);
        assert_eq!(create_sender(Some("*"), true).unwrap(), CATCH_ALL);
        assert!(create_sender(Some("*"), false).is_err());
        assert!(create_sender(Some("a@b.com"), true).is_err());
        assert!(create_sender(None, false).is_err());
        assert_eq!(create_sender(Some("A@B.com"), false).unwrap(), "a@b.com");
        // normalize_sender never yields the catch-all marker.
        assert!(normalize_sender("*").is_err());
    }

    #[test]
    fn resolve_folder_exact_and_inbox() {
        let fs = vec![folder("INBOX", "."), folder("INBOX.Clients", ".")];
        assert_eq!(resolve_folder(&fs, "inbox").as_deref(), Some("INBOX"));
        assert_eq!(resolve_folder(&fs, "INBOX.Clients").as_deref(), Some("INBOX.Clients"));
        assert_eq!(resolve_folder(&fs, "Clients"), None);
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
