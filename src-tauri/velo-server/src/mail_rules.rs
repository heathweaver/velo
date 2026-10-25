//! Inbox rules an agent (or an admin) can set up: "when a message's from / to /
//! subject contains X, move it to a folder, mark it read, or star it" — the
//! basic Apple Mail rule set.
//!
//! - Rules belong to a server mailbox and are evaluated in creation order.
//!   Every matching rule's flag actions apply; the first matching move wins.
//! - Rules never delete mail. The only actions are `move`, `mark_read`, `star`.
//! - `apply_now` runs the rules over the newest messages already in a folder.
//! - A background pass runs them over new INBOX mail every `POLL_SECS`. A
//!   mailbox is only looked at once it has an enabled rule, and the first look
//!   only records a high-water mark (no surprise backfill).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use velo_core::imap::scheduler::Priority;
use velo_core::ops;
use velo_core::ImapMessage;

use crate::mailboxes::{self, MailboxCreds};
use crate::state::{new_id, AppState};

const POLL_SECS: u64 = 120;
const FETCH_CHUNK: usize = 100;
const MAX_RULES_PER_MAILBOX: i64 = 100;
const MAX_APPLY: usize = 200;
const MAX_VALUE_CHARS: usize = 200;

pub const FIELDS: [&str; 3] = ["from", "to", "subject"];
pub const ACTIONS: [&str; 3] = ["move", "mark_read", "star"];

pub async fn migrate(conn: &mut SqliteConnection) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mail_rules (
            id TEXT PRIMARY KEY,
            mailbox_id TEXT NOT NULL,
            name TEXT NOT NULL,
            field TEXT NOT NULL CHECK (field IN ('from','to','subject')),
            value TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('move','mark_read','star')),
            folder TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create mail_rules table failed");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mail_rule_state (
            mailbox_id TEXT PRIMARY KEY,
            last_uid INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create mail_rule_state table failed");
}

#[derive(Clone, Debug, sqlx::FromRow, Serialize)]
pub struct Rule {
    pub id: String,
    pub mailbox_id: String,
    pub name: String,
    pub field: String,
    pub value: String,
    pub action: String,
    pub folder: Option<String>,
    #[serde(serialize_with = "as_bool")]
    pub enabled: i64,
    pub created_by: String,
    pub created_at: i64,
}

fn as_bool<S: serde::Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(*v != 0)
}

// ---------- matching ----------

fn haystack(field: &str, m: &ImapMessage) -> String {
    match field {
        "from" => format!(
            "{} {}",
            m.from_name.as_deref().unwrap_or(""),
            m.from_address.as_deref().unwrap_or("")
        ),
        "to" => m.to_addresses.clone().unwrap_or_default(),
        _ => m.subject.clone().unwrap_or_default(),
    }
    .to_lowercase()
}

pub fn rule_matches(rule: &Rule, m: &ImapMessage) -> bool {
    rule.enabled != 0 && haystack(&rule.field, m).contains(&rule.value.to_lowercase())
}

/// What to do to a batch of messages in one folder.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub mark_read: Vec<u32>,
    pub star: Vec<u32>,
    pub moves: BTreeMap<String, Vec<u32>>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.mark_read.is_empty() && self.star.is_empty() && self.moves.is_empty()
    }
}

/// `rules` must already be in creation order.
pub fn plan(rules: &[Rule], msgs: &[ImapMessage]) -> Plan {
    let mut p = Plan::default();
    for m in msgs {
        let mut moved = false;
        for r in rules.iter().filter(|r| rule_matches(r, m)) {
            match r.action.as_str() {
                "mark_read" if !m.is_read && !p.mark_read.contains(&m.uid) => p.mark_read.push(m.uid),
                "star" if !m.is_starred && !p.star.contains(&m.uid) => p.star.push(m.uid),
                "move" if !moved => {
                    if let Some(f) = r.folder.as_deref() {
                        p.moves.entry(f.to_string()).or_default().push(m.uid);
                        moved = true;
                    }
                }
                _ => {}
            }
        }
    }
    p
}

// ---------- validation ----------

pub struct NewRule {
    pub name: String,
    pub field: String,
    pub value: String,
    pub action: String,
    pub folder: Option<String>,
}

pub fn validate(r: &NewRule) -> Result<(), String> {
    if !FIELDS.contains(&r.field.as_str()) {
        return Err(format!("'field' must be one of: {}", FIELDS.join(", ")));
    }
    if !ACTIONS.contains(&r.action.as_str()) {
        return Err(format!("'action' must be one of: {}", ACTIONS.join(", ")));
    }
    let v = r.value.trim();
    if v.is_empty() || v.chars().count() > MAX_VALUE_CHARS {
        return Err(format!("'value' must be 1-{MAX_VALUE_CHARS} characters"));
    }
    if r.name.trim().is_empty() || r.name.chars().count() > 100 {
        return Err("'name' must be 1-100 characters".into());
    }
    match (r.action.as_str(), r.folder.as_deref().map(str::trim)) {
        ("move", None | Some("")) => Err("'folder' is required for a move rule".into()),
        ("move", Some(f)) if f.chars().any(char::is_control) => Err("'folder' has invalid characters".into()),
        ("move", Some(_)) => Ok(()),
        (_, Some(f)) if !f.is_empty() => Err("'folder' only applies to move rules".into()),
        _ => Ok(()),
    }
}

// ---------- storage ----------

pub async fn list(state: &AppState, mailbox_id: &str) -> Vec<Rule> {
    let mut c = state.control.lock().await;
    sqlx::query_as::<_, Rule>("SELECT * FROM mail_rules WHERE mailbox_id = $1 ORDER BY created_at, id")
        .bind(mailbox_id)
        .fetch_all(&mut *c)
        .await
        .unwrap_or_default()
}

pub async fn create(state: &AppState, mailbox_id: &str, by: &str, r: &NewRule) -> Result<Rule, String> {
    validate(r)?;
    let mut c = state.control.lock().await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mail_rules WHERE mailbox_id = $1")
        .bind(mailbox_id)
        .fetch_one(&mut *c)
        .await
        .map_err(|e| e.to_string())?;
    if count >= MAX_RULES_PER_MAILBOX {
        return Err(format!("A mailbox can have at most {MAX_RULES_PER_MAILBOX} rules"));
    }
    let id = new_id();
    let at = chrono_now();
    sqlx::query(
        "INSERT INTO mail_rules (id, mailbox_id, name, field, value, action, folder, enabled, created_by, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)",
    )
    .bind(&id)
    .bind(mailbox_id)
    .bind(r.name.trim())
    .bind(&r.field)
    .bind(r.value.trim())
    .bind(&r.action)
    .bind(r.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()))
    .bind(by)
    .bind(at)
    .execute(&mut *c)
    .await
    .map_err(|e| e.to_string())?;
    drop(c);
    list(state, mailbox_id)
        .await
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| "Rule was not saved".to_string())
}

/// Replace a rule's settings (and enabled flag). The rule must belong to the mailbox.
pub async fn update(state: &AppState, mailbox_id: &str, id: &str, r: &NewRule, enabled: bool) -> Result<Rule, String> {
    validate(r)?;
    let mut c = state.control.lock().await;
    let done = sqlx::query(
        "UPDATE mail_rules SET name=$3, field=$4, value=$5, action=$6, folder=$7, enabled=$8 \
         WHERE id=$1 AND mailbox_id=$2",
    )
    .bind(id)
    .bind(mailbox_id)
    .bind(r.name.trim())
    .bind(&r.field)
    .bind(r.value.trim())
    .bind(&r.action)
    .bind(r.folder.as_deref().map(str::trim).filter(|f| !f.is_empty()))
    .bind(enabled as i64)
    .execute(&mut *c)
    .await
    .map_err(|e| e.to_string())?;
    if done.rows_affected() == 0 {
        return Err("No such rule in this mailbox".into());
    }
    drop(c);
    list(state, mailbox_id)
        .await
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| "No such rule in this mailbox".to_string())
}

pub async fn delete(state: &AppState, mailbox_id: &str, id: &str) -> Result<(), String> {
    let mut c = state.control.lock().await;
    let done = sqlx::query("DELETE FROM mail_rules WHERE id=$1 AND mailbox_id=$2")
        .bind(id)
        .bind(mailbox_id)
        .execute(&mut *c)
        .await
        .map_err(|e| e.to_string())?;
    if done.rows_affected() == 0 {
        return Err("No such rule in this mailbox".into());
    }
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- running ----------

/// Carry out a plan. Flags first, then moves, so a message is marked before it leaves.
pub async fn execute(creds: &MailboxCreds, folder: &str, p: &Plan, prio: Priority) -> Result<(), String> {
    if !p.mark_read.is_empty() {
        ops::imap_set_flags(creds.imap.clone(), folder.into(), p.mark_read.clone(), vec!["\\Seen".into()], true, prio).await?;
    }
    if !p.star.is_empty() {
        ops::imap_set_flags(creds.imap.clone(), folder.into(), p.star.clone(), vec!["\\Flagged".into()], true, prio).await?;
    }
    for (dest, uids) in &p.moves {
        ops::imap_move_messages(creds.imap.clone(), folder.into(), uids.clone(), dest.clone(), prio).await?;
    }
    Ok(())
}

async fn headers(creds: &MailboxCreds, folder: &str, uids: &[u32], prio: Priority) -> Result<Vec<ImapMessage>, String> {
    let mut out = Vec::new();
    for chunk in uids.chunks(FETCH_CHUNK) {
        out.extend(ops::imap_fetch_messages(creds.imap.clone(), folder.into(), chunk.to_vec(), true, prio).await?.messages);
    }
    Ok(out)
}

/// Run the mailbox's rules over the newest `limit` messages in `folder`.
pub async fn apply_now(state: &AppState, creds: &MailboxCreds, folder: &str, limit: usize) -> Result<Value, String> {
    let rules = list(state, &creds.id).await;
    if rules.iter().all(|r| r.enabled == 0) {
        return Ok(json!({ "checked": 0, "moved": 0, "marked_read": 0, "starred": 0, "note": "No enabled rules" }));
    }
    let mut uids = ops::imap_search_all_uids(creds.imap.clone(), folder.into(), Priority::Interactive).await?;
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(limit.clamp(1, MAX_APPLY));
    let msgs = headers(creds, folder, &uids, Priority::Interactive).await?;
    let p = plan(&rules, &msgs);
    execute(creds, folder, &p, Priority::Interactive).await?;
    Ok(json!({
        "checked": msgs.len(),
        "moved": p.moves.values().map(Vec::len).sum::<usize>(),
        "marked_read": p.mark_read.len(),
        "starred": p.star.len(),
    }))
}

// ---------- background pass over new mail ----------

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(POLL_SECS));
        loop {
            tick.tick().await;
            for mb in mailboxes::all_with_creds(&state).await {
                if let Err(e) = poll_mailbox(&state, &mb).await {
                    tracing::warn!("mail rules: mailbox {} failed: {e}", mb.email);
                }
            }
        }
    });
}

async fn last_uid(state: &AppState, id: &str) -> Option<u32> {
    let mut c = state.control.lock().await;
    sqlx::query_scalar::<_, i64>("SELECT last_uid FROM mail_rule_state WHERE mailbox_id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await
        .ok()
        .flatten()
        .map(|v| v as u32)
}

async fn set_last_uid(state: &AppState, id: &str, uid: u32) {
    let mut c = state.control.lock().await;
    let _ = sqlx::query(
        "INSERT INTO mail_rule_state (mailbox_id, last_uid) VALUES ($1,$2) \
         ON CONFLICT(mailbox_id) DO UPDATE SET last_uid = $2",
    )
    .bind(id)
    .bind(uid as i64)
    .execute(&mut *c)
    .await;
}

async fn poll_mailbox(state: &AppState, mb: &MailboxCreds) -> Result<(), String> {
    let rules = list(state, &mb.id).await;
    if rules.iter().all(|r| r.enabled == 0) {
        return Ok(());
    }
    let status = ops::imap_get_folder_status(mb.imap.clone(), "INBOX".into(), Priority::Background).await?;
    let high = status.uidnext.saturating_sub(1);
    let last = match last_uid(state, &mb.id).await {
        Some(u) if u <= high => u,
        _ => {
            // First look, or UIDs were reset: remember where we are, don't backfill.
            set_last_uid(state, &mb.id, high).await;
            return Ok(());
        }
    };
    if high <= last {
        return Ok(());
    }
    let new_uids = ops::imap_fetch_new_uids(mb.imap.clone(), "INBOX".into(), last, Priority::Background).await?;
    if !new_uids.is_empty() {
        let msgs = headers(mb, "INBOX", &new_uids, Priority::Background).await?;
        let p = plan(&rules, &msgs);
        if !p.is_empty() {
            // A failed move (e.g. folder missing) must not wedge the mailbox forever.
            if let Err(e) = execute(mb, "INBOX", &p, Priority::Background).await {
                tracing::warn!("mail rules: {} could not apply a rule: {e}", mb.email);
            }
        }
    }
    set_last_uid(state, &mb.id, new_uids.iter().copied().max().unwrap_or(last).max(high)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(field: &str, value: &str, action: &str, folder: Option<&str>) -> Rule {
        Rule {
            id: new_id(),
            mailbox_id: "m".into(),
            name: "r".into(),
            field: field.into(),
            value: value.into(),
            action: action.into(),
            folder: folder.map(str::to_string),
            enabled: 1,
            created_by: "t".into(),
            created_at: 0,
        }
    }

    fn msg(uid: u32, from: &str, subject: &str) -> ImapMessage {
        serde_json::from_value(json!({
            "uid": uid, "folder": "INBOX", "from_address": from, "subject": subject,
            "date": 0, "is_read": false, "is_starred": false, "is_draft": false, "raw_size": 0, "attachments": []
        }))
        .expect("message")
    }

    #[test]
    fn matches_contains_case_insensitive() {
        let r = rule("from", "NEWS@", "move", Some("Reads"));
        assert!(rule_matches(&r, &msg(1, "news@example.com", "x")));
        assert!(!rule_matches(&r, &msg(2, "bob@example.com", "x")));
        let s = rule("subject", "invoice", "star", None);
        assert!(rule_matches(&s, &msg(3, "a@b.c", "Your INVOICE is ready")));
    }

    #[test]
    fn disabled_rules_never_match() {
        let mut r = rule("from", "a", "star", None);
        r.enabled = 0;
        assert!(!rule_matches(&r, &msg(1, "a@b.c", "")));
    }

    #[test]
    fn plan_first_move_wins_and_flags_all_apply() {
        let rules = vec![
            rule("from", "news", "move", Some("Reads")),
            rule("from", "news", "move", Some("Other")),
            rule("from", "news", "mark_read", None),
            rule("subject", "urgent", "star", None),
        ];
        let msgs = vec![msg(1, "news@x.com", "Urgent news"), msg(2, "bob@x.com", "hi")];
        let p = plan(&rules, &msgs);
        assert_eq!(p.moves.get("Reads"), Some(&vec![1]));
        assert!(!p.moves.contains_key("Other"));
        assert_eq!(p.mark_read, vec![1]);
        assert_eq!(p.star, vec![1]);
    }

    #[test]
    fn plan_skips_flags_already_set() {
        let mut m = msg(1, "a@b.c", "");
        m.is_read = true;
        m.is_starred = true;
        let p = plan(&[rule("from", "a", "mark_read", None), rule("from", "a", "star", None)], &[m]);
        assert!(p.is_empty());
    }

    #[test]
    fn validation() {
        let ok = NewRule { name: "n".into(), field: "from".into(), value: "x".into(), action: "move".into(), folder: Some("Reads".into()) };
        assert!(validate(&ok).is_ok());
        let bad = |f: &dyn Fn(&mut NewRule)| {
            let mut r = NewRule { name: "n".into(), field: "from".into(), value: "x".into(), action: "move".into(), folder: Some("Reads".into()) };
            f(&mut r);
            validate(&r).is_err()
        };
        assert!(bad(&|r| r.field = "body".into()));
        assert!(bad(&|r| r.action = "delete".into()));
        assert!(bad(&|r| r.value = "  ".into()));
        assert!(bad(&|r| r.folder = None));
        assert!(bad(&|r| { r.action = "star".into(); }));
        assert!(bad(&|r| r.name = "".into()));
    }
}
