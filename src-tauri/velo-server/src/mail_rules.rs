//! Velo's one rule system: server-side mail rules that agents (and the seed)
//! manage — "when a message's from / to / subject contains X, do Y".
//!
//! - Rules belong to a server mailbox and are evaluated in creation order.
//!   Every matching rule's flag actions (`mark_read`, `star`) apply first; the
//!   first matching `move` or `trash` then wins.
//! - `move` goes to a folder in the same mailbox, or — with `dest_mailbox_id` —
//!   into a folder of another of the owner's mailboxes. That is a true move
//!   (see `transfer.rs`): APPEND to the destination, and only then remove the
//!   source UID. Never forwarded, folders never created.
//! - `trash` moves to the mailbox's Trash folder (special-use `\Trash`, else a
//!   well-known Trash name). It is a separate, persisted action that only a
//!   passphrase allowed to delete (read-and-send, deletion block off) may create
//!   or change. That authorisation is stored on the rule
//!   (`trash_authorized_by`), so background runs continue without the creating
//!   passphrase. A plain `move` into a Trash folder is refused; nothing is ever
//!   permanently deleted by a rule.
//! - Reads is a top-level folder named `Reads` in every mailbox. Existing
//!   `INBOX.Reads` folders are renamed (or merged into `Reads`, keeping the old
//!   folder) by `ensure_reads`; rule polling waits for that to succeed.
//! - A catch-all rule is `from` containing `@` (every sender address has one).
//! - `apply_now` runs the rules over the newest messages already in a folder,
//!   or every existing message when explicitly requested, in bounded batches.
//! - A background pass runs them over new INBOX mail every `POLL_SECS`. A
//!   mailbox is only looked at once it has an enabled rule, and the first look
//!   only records a high-water mark (no surprise backfill).
//! - The old `filing_rules` / `filing_state` tables are converted into rows
//!   here (`migrate_legacy`) and dropped; `mail_rule_seeds` records which seed
//!   identities were already imported so seeds never resurrect edits/deletions.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use velo_core::imap::scheduler::Priority;
use velo_core::ops;
use velo_core::{ImapFolder, ImapMessage};

use crate::mailboxes::{self, MailboxCreds};
use crate::state::{new_id, AppState};

const POLL_SECS: u64 = 120;
const FETCH_CHUNK: usize = 100;
const MAX_RULES_PER_MAILBOX: i64 = 100;
const MAX_APPLY: usize = 200;
const MAX_VALUE_CHARS: usize = 200;

pub const FIELDS: [&str; 3] = ["from", "to", "subject"];
pub const ACTIONS: [&str; 4] = ["move", "mark_read", "star", "trash"];
pub const ACTION_TRASH: &str = "trash";
/// `from` value of a catch-all rule: every sender address contains `@`.
pub const CATCH_ALL_VALUE: &str = "@";
/// Seed / legacy identity of a catch-all sender.
pub const CATCH_ALL_SENDER: &str = "*";
/// The top-level Reads folder.
pub const READS: &str = "Reads";

pub const SOURCE_AGENT: &str = "agent";
pub const SOURCE_SEED: &str = "seed";
pub const SOURCE_LEGACY: &str = "legacy_filer";

/// Catch-alls sort after every specific rule (the old filer let specific
/// senders beat the catch-all); rules run in `created_at` order.
const CATCH_ALL_ORDER_OFFSET: i64 = 4_000_000_000;

pub const TRASH_DENIED: &str =
    "Trash rules need a passphrase that may delete (read and send, with the deletion block off)";

fn create_table_sql(name: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {name} (
            id TEXT PRIMARY KEY,
            mailbox_id TEXT NOT NULL,
            name TEXT NOT NULL,
            field TEXT NOT NULL CHECK (field IN ('from','to','subject')),
            value TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('move','mark_read','star','trash')),
            folder TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            dest_mailbox_id TEXT,
            source TEXT NOT NULL DEFAULT 'agent',
            trash_authorized_by TEXT
        )"
    )
}

const RULE_COLUMNS: &str = "id, mailbox_id, name, field, value, action, folder, enabled, created_by, \
                            created_at, dest_mailbox_id, source, trash_authorized_by";

pub async fn migrate(conn: &mut SqliteConnection) {
    sqlx::query(&create_table_sql("mail_rules"))
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

    // Which seed identities (mailbox + sender) were already imported, and the
    // mail_rules row each maps to. Holds no executable rule.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mail_rule_seeds (
            mailbox_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            rule_id TEXT NOT NULL,
            PRIMARY KEY (mailbox_id, sender)
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create mail_rule_seeds table failed");

    // Mailboxes whose INBOX.Reads → Reads migration succeeded.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS reads_migration (
            mailbox_id TEXT PRIMARY KEY,
            done_at INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create reads_migration table failed");

    // Columns added after the first release (ignore "duplicate column").
    for col in [
        "dest_mailbox_id TEXT",
        "source TEXT NOT NULL DEFAULT 'agent'",
        "trash_authorized_by TEXT",
    ] {
        let _ = sqlx::query(&format!("ALTER TABLE mail_rules ADD COLUMN {col}"))
            .execute(&mut *conn)
            .await;
    }

    // The action CHECK of the first release has no 'trash': rebuild the table.
    let ddl: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='mail_rules'")
        .fetch_optional(&mut *conn)
        .await
        .ok()
        .flatten();
    if ddl.is_some_and(|d| !d.contains("'trash'")) {
        if let Err(e) = rebuild_rules_table(&mut *conn).await {
            tracing::error!("mail rules: could not add the trash action to mail_rules: {e}");
        }
    }

    migrate_legacy(&mut *conn).await;
}

async fn rebuild_rules_table(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut tx = conn.begin().await?;
    sqlx::query("DROP TABLE IF EXISTS mail_rules_new").execute(&mut *tx).await?;
    sqlx::query(&create_table_sql("mail_rules_new")).execute(&mut *tx).await?;
    sqlx::query(&format!(
        "INSERT INTO mail_rules_new ({RULE_COLUMNS}) SELECT {RULE_COLUMNS} FROM mail_rules"
    ))
    .execute(&mut *tx)
    .await?;
    sqlx::query("DROP TABLE mail_rules").execute(&mut *tx).await?;
    sqlx::query("ALTER TABLE mail_rules_new RENAME TO mail_rules").execute(&mut *tx).await?;
    tx.commit().await
}

// ---------- legacy filer conversion ----------

async fn table_columns(conn: &mut SqliteConnection, table: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .fetch_all(&mut *conn)
        .await
        .unwrap_or_default()
}

/// Convert `filing_rules` (and the `filing_state` watermarks) into `mail_rules`
/// rows in ONE transaction, then drop the old tables. Nothing is dropped unless
/// every row was converted; on failure the old tables stay and it retries on the
/// next start.
async fn migrate_legacy(conn: &mut SqliteConnection) {
    let rules = !table_columns(conn, "filing_rules").await.is_empty();
    let state = !table_columns(conn, "filing_state").await.is_empty();
    if !rules && !state {
        return;
    }
    match migrate_legacy_tx(conn, rules, state).await {
        Ok((converted, skipped)) => {
            tracing::info!("mail rules: converted {converted} legacy filing rule(s) ({skipped} unusable skipped); legacy tables dropped")
        }
        Err(e) => tracing::error!("mail rules: legacy filing migration failed, tables kept for retry: {e}"),
    }
}

type LegacyRow = (String, Option<String>, Option<String>, Option<String>, String, i64, i64, Option<String>, Option<String>);

async fn migrate_legacy_tx(conn: &mut SqliteConnection, rules: bool, state: bool) -> Result<(usize, usize), sqlx::Error> {
    let cols = if rules { table_columns(conn, "filing_rules").await } else { vec![] };
    let pick = |c: &str| if cols.iter().any(|x| x == c) { c.to_string() } else { "NULL".to_string() };
    let created = if cols.iter().any(|x| x == "created_at") { "COALESCE(created_at, 0)".to_string() } else { "0".to_string() };
    let enabled = if cols.iter().any(|x| x == "enabled") { "COALESCE(enabled, 1)".to_string() } else { "1".to_string() };

    let mut tx = conn.begin().await?;
    let (mut converted, mut skipped) = (0usize, 0usize);
    if rules {
        let rows: Vec<LegacyRow> = sqlx::query_as(&format!(
            "SELECT id, {}, {}, {}, COALESCE(action, 'move_reads'), {enabled}, {created}, {}, {} FROM filing_rules",
            pick("user_id"), pick("mailbox_id"), pick("sender_email"), pick("dest_mailbox_id"), pick("dest_folder")
        ))
        .fetch_all(&mut *tx)
        .await?;
        for (id, user, mailbox, sender, action, enabled, created_at, dest_mailbox, dest_folder) in rows {
            let (Some(mailbox), Some(sender)) = (mailbox, sender.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())) else {
                skipped += 1;
                continue;
            };
            let catch_all = sender == CATCH_ALL_SENDER;
            let (folder, dest) = match action.as_str() {
                "move_reads" => (READS.to_string(), None),
                "move" => {
                    let f = dest_folder.as_deref().map(normalize_reads).filter(|f| !f.is_empty());
                    match f {
                        Some(f) => (f, dest_mailbox.filter(|d| *d != mailbox)),
                        None => {
                            tracing::warn!("mail rules: legacy rule {id} has no destination folder; skipped");
                            skipped += 1;
                            continue;
                        }
                    }
                }
                other => {
                    tracing::warn!("mail rules: legacy rule {id} has unknown action '{other}'; skipped");
                    skipped += 1;
                    continue;
                }
            };
            let value = if catch_all { CATCH_ALL_VALUE.to_string() } else { sender.clone() };
            let name = rule_name("Filer", if catch_all { "everything" } else { &sender });
            let at = created_at + if catch_all { CATCH_ALL_ORDER_OFFSET } else { 0 };
            sqlx::query(
                "INSERT OR IGNORE INTO mail_rules (id, mailbox_id, name, field, value, action, folder, enabled, \
                 created_by, created_at, dest_mailbox_id, source) VALUES ($1,$2,$3,'from',$4,'move',$5,$6,$7,$8,$9,$10)",
            )
            .bind(&id)
            .bind(&mailbox)
            .bind(&name)
            .bind(&value)
            .bind(&folder)
            .bind((enabled != 0) as i64)
            .bind(user.as_deref().unwrap_or("legacy-filer"))
            .bind(at)
            .bind(&dest)
            .bind(SOURCE_LEGACY)
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT OR IGNORE INTO mail_rule_seeds (mailbox_id, sender, rule_id) VALUES ($1,$2,$3)")
                .bind(&mailbox)
                .bind(&sender)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            converted += 1;
        }
        sqlx::query("DROP TABLE filing_rules").execute(&mut *tx).await?;
    }
    if state {
        // Keep the "only new mail" watermark where the old filer had it.
        sqlx::query(
            "INSERT OR IGNORE INTO mail_rule_state (mailbox_id, last_uid) \
             SELECT mailbox_id, last_uid FROM filing_state WHERE last_uid IS NOT NULL AND mailbox_id IS NOT NULL",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DROP TABLE filing_state").execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok((converted, skipped))
}

fn rule_name(prefix: &str, what: &str) -> String {
    let mut n = format!("{prefix}: {what}");
    if n.chars().count() > 100 {
        n = n.chars().take(100).collect();
    }
    n
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
    /// Destination mailbox for `move` (None = same mailbox).
    #[sqlx(default)]
    pub dest_mailbox_id: Option<String>,
    /// Where the rule came from: `agent`, `seed` or `legacy_filer`.
    #[sqlx(default)]
    pub source: String,
    /// Passphrase that authorised a `trash` rule; execution needs it.
    #[sqlx(default)]
    pub trash_authorized_by: Option<String>,
}

fn as_bool<S: serde::Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_bool(*v != 0)
}

// ---------- folder helpers ----------

/// `INBOX.Reads` / `INBOX/Reads` (any case, any single separator) → `Reads`.
pub fn normalize_reads(folder: &str) -> String {
    let f = folder.trim();
    if f.is_ascii()
        && f.len() == "INBOX.Reads".len()
        && f[..5].eq_ignore_ascii_case("INBOX")
        && matches!(f.as_bytes()[5], b'.' | b'/')
        && f[6..].eq_ignore_ascii_case(READS)
    {
        return READS.to_string();
    }
    f.to_string()
}

/// A folder name that is a Trash folder by convention (last path segment).
pub fn is_known_trash_name(folder: &str) -> bool {
    let last = folder.trim().rsplit(['.', '/']).next().unwrap_or("").trim().to_lowercase();
    matches!(
        last.as_str(),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" | "corbeille" | "unsolbox"
    )
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

/// The mailbox's Trash folder: special-use `\Trash`, else a well-known name.
pub fn trash_folder(folders: &[ImapFolder]) -> Option<String> {
    folders
        .iter()
        .find(|f| f.special_use.as_deref() == Some("\\Trash"))
        .or_else(|| folders.iter().find(|f| is_known_trash_name(&f.path) || is_known_trash_name(&f.raw_path)))
        .map(|f| f.raw_path.clone())
}

/// Whether moving *into* `raw` would put mail in Trash (special-use or name).
fn is_trash_destination(folders: &[ImapFolder], raw: &str) -> bool {
    is_known_trash_name(raw)
        || folders
            .iter()
            .any(|f| (f.raw_path == raw || f.path == raw) && (f.special_use.as_deref() == Some("\\Trash") || is_known_trash_name(&f.path)))
}

/// A move destination that exists in `folders` and is not a Trash folder.
fn checked_dest(folders: &[ImapFolder], name: &str, email: &str) -> Result<String, String> {
    let raw = resolve_folder(folders, name).ok_or_else(|| format!("Folder '{name}' not found in {email} (not created)"))?;
    if is_trash_destination(folders, &raw) {
        return Err(format!("'{name}' in {email} is a Trash folder; use the trash action (it needs permission to delete)"));
    }
    Ok(raw)
}

/// Normalize a rule sender: trimmed + lowercased. Accepts a full address
/// (`news@example.com`) or a domain wildcard (`@example.com`).
pub fn normalize_sender(s: &str) -> Result<String, String> {
    let s = s.trim().trim_start_matches('<').trim_end_matches('>').trim().to_lowercase();
    if s.is_empty() {
        return Err("sender is required".into());
    }
    if s.chars().any(char::is_whitespace) {
        return Err("sender must not contain spaces".into());
    }
    match s.find('@') {
        Some(i) if i == s.rfind('@').unwrap() && i + 1 < s.len() => Ok(s),
        _ => Err("sender must be an address (a@b.com) or @domain".into()),
    }
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
    /// Cross-mailbox moves keyed by (destination mailbox id, folder).
    pub transfers: BTreeMap<(String, String), Vec<u32>>,
    /// Messages going to the mailbox's Trash folder.
    pub trash: Vec<u32>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.mark_read.is_empty()
            && self.star.is_empty()
            && self.moves.is_empty()
            && self.transfers.is_empty()
            && self.trash.is_empty()
    }
}

/// `rules` must already be in creation order. All matching flags are planned;
/// the first matching move or trash wins.
pub fn plan(rules: &[Rule], msgs: &[ImapMessage]) -> Plan {
    let mut p = Plan::default();
    for m in msgs {
        let mut moved = false;
        for r in rules.iter().filter(|r| rule_matches(r, m)) {
            match r.action.as_str() {
                "mark_read" if !m.is_read && !p.mark_read.contains(&m.uid) => p.mark_read.push(m.uid),
                "star" if !m.is_starred && !p.star.contains(&m.uid) => p.star.push(m.uid),
                "move" if !moved => {
                    if let Some(f) = r.folder.as_deref().map(normalize_reads) {
                        match r.dest_mailbox_id.as_deref().filter(|d| *d != r.mailbox_id) {
                            Some(d) => p.transfers.entry((d.to_string(), f)).or_default().push(m.uid),
                            None => p.moves.entry(f).or_default().push(m.uid),
                        }
                        moved = true;
                    }
                }
                // Only a rule that carries a stored delete authorisation may trash.
                "trash" if !moved && r.trash_authorized_by.is_some() => {
                    p.trash.push(m.uid);
                    moved = true;
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
    /// Cross-mailbox destination (already resolved and permission-checked).
    pub dest_mailbox_id: Option<String>,
}

/// The folder as stored: trimmed, empty → none, INBOX.Reads → Reads.
fn clean_folder(r: &NewRule) -> Option<String> {
    r.folder.as_deref().map(normalize_reads).filter(|f| !f.is_empty())
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
    if r.dest_mailbox_id.is_some() && r.action != "move" {
        return Err("'dest_mailbox' only applies to move rules".into());
    }
    match (r.action.as_str(), clean_folder(r).as_deref()) {
        ("move", None) => Err("'folder' is required for a move rule".into()),
        ("move", Some(f)) if f.chars().any(char::is_control) => Err("'folder' has invalid characters".into()),
        ("move", Some(f)) if is_known_trash_name(f) => {
            Err("A move rule cannot target a Trash folder; use the 'trash' action".into())
        }
        ("move", Some(_)) => Ok(()),
        (_, Some(_)) => Err("'folder' only applies to move rules".into()),
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

/// `trash_by` is the id of the passphrase making the change when (and only when)
/// that passphrase may delete; a trash rule cannot be saved without it.
pub async fn create(state: &AppState, mailbox_id: &str, by: &str, r: &NewRule, trash_by: Option<&str>) -> Result<Rule, String> {
    validate(r)?;
    if r.action == ACTION_TRASH && trash_by.is_none() {
        return Err(TRASH_DENIED.into());
    }
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
        "INSERT INTO mail_rules (id, mailbox_id, name, field, value, action, folder, enabled, created_by, created_at, \
         dest_mailbox_id, source, trash_authorized_by) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)",
    )
    .bind(&id)
    .bind(mailbox_id)
    .bind(r.name.trim())
    .bind(&r.field)
    .bind(r.value.trim())
    .bind(&r.action)
    .bind(clean_folder(r))
    .bind(by)
    .bind(at)
    .bind(r.dest_mailbox_id.as_deref().filter(|d| *d != mailbox_id))
    .bind(SOURCE_AGENT)
    .bind(if r.action == ACTION_TRASH { trash_by } else { None })
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

/// Replace a rule's settings (and enabled flag). The rule must belong to the
/// mailbox. Creating a trash rule, or changing an existing one, needs `trash_by`.
pub async fn update(
    state: &AppState,
    mailbox_id: &str,
    id: &str,
    r: &NewRule,
    enabled: bool,
    trash_by: Option<&str>,
) -> Result<Rule, String> {
    validate(r)?;
    let mut c = state.control.lock().await;
    let old: Option<String> = sqlx::query_scalar("SELECT action FROM mail_rules WHERE id=$1 AND mailbox_id=$2")
        .bind(id)
        .bind(mailbox_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| e.to_string())?;
    let Some(old_action) = old else {
        return Err("No such rule in this mailbox".into());
    };
    if (old_action == ACTION_TRASH || r.action == ACTION_TRASH) && trash_by.is_none() {
        return Err(TRASH_DENIED.into());
    }
    let done = sqlx::query(
        "UPDATE mail_rules SET name=$3, field=$4, value=$5, action=$6, folder=$7, enabled=$8, dest_mailbox_id=$9, \
         trash_authorized_by=$10 WHERE id=$1 AND mailbox_id=$2",
    )
    .bind(id)
    .bind(mailbox_id)
    .bind(r.name.trim())
    .bind(&r.field)
    .bind(r.value.trim())
    .bind(&r.action)
    .bind(clean_folder(r))
    .bind(enabled as i64)
    .bind(r.dest_mailbox_id.as_deref().filter(|d| *d != mailbox_id))
    .bind(if r.action == ACTION_TRASH { trash_by } else { None })
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

// ---------- seeding ----------

fn seed_rule_id(mailbox_id: &str, sender: &str) -> String {
    let digest = Sha256::digest(format!("velo-seed:{mailbox_id}:{sender}").as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// What a seed wants: a `from`-contains-sender rule that moves to a folder.
pub struct SeedRule<'a> {
    pub mailbox_id: &'a str,
    /// `normalize_sender` output, or `*` for a catch-all.
    pub sender: &'a str,
    pub folder: &'a str,
    pub dest_mailbox_id: Option<&'a str>,
    pub enabled: bool,
    pub created_by: &'a str,
}

/// Import one seed rule at most once. Returns true when a rule was inserted.
/// A sender that already has a rule (including a converted legacy one) is only
/// recorded in the ledger; a ledger entry means "already imported", so later
/// edits, disabling and deletion are never undone.
pub async fn seed_rule(conn: &mut SqliteConnection, s: &SeedRule<'_>) -> Result<bool, String> {
    let e = |e: sqlx::Error| e.to_string();
    let catch_all = s.sender == CATCH_ALL_SENDER;
    let value = if catch_all { CATCH_ALL_VALUE } else { s.sender };
    let folder = normalize_reads(s.folder);
    let dest = s.dest_mailbox_id.filter(|d| *d != s.mailbox_id);
    let new = NewRule {
        name: rule_name(if folder == READS { "Reads" } else { "Move" }, if catch_all { "everything" } else { s.sender }),
        field: "from".into(),
        value: value.into(),
        action: "move".into(),
        folder: Some(folder.clone()),
        dest_mailbox_id: dest.map(str::to_string),
    };
    validate(&new)?;
    if dest.is_none() && folder.eq_ignore_ascii_case("INBOX") {
        return Err("moving INBOX to its own INBOX does nothing".into());
    }

    let mut tx = conn.begin().await.map_err(e)?;
    let known: Option<String> = sqlx::query_scalar("SELECT rule_id FROM mail_rule_seeds WHERE mailbox_id=$1 AND sender=$2")
        .bind(s.mailbox_id)
        .bind(s.sender)
        .fetch_optional(&mut *tx)
        .await
        .map_err(e)?;
    if known.is_some() {
        return Ok(false);
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM mail_rules WHERE mailbox_id=$1 AND field='from' AND lower(value)=lower($2) ORDER BY created_at, id LIMIT 1",
    )
    .bind(s.mailbox_id)
    .bind(value)
    .fetch_optional(&mut *tx)
    .await
    .map_err(e)?;
    let (rule_id, inserted) = match existing {
        Some(id) => (id, false),
        None => {
            let id = seed_rule_id(s.mailbox_id, s.sender);
            let at = chrono_now() + if catch_all { CATCH_ALL_ORDER_OFFSET } else { 0 };
            sqlx::query(
                "INSERT OR IGNORE INTO mail_rules (id, mailbox_id, name, field, value, action, folder, enabled, created_by, \
                 created_at, dest_mailbox_id, source) VALUES ($1,$2,$3,'from',$4,'move',$5,$6,$7,$8,$9,$10)",
            )
            .bind(&id)
            .bind(s.mailbox_id)
            .bind(&new.name)
            .bind(value)
            .bind(&folder)
            .bind(s.enabled as i64)
            .bind(s.created_by)
            .bind(at)
            .bind(dest)
            .bind(SOURCE_SEED)
            .execute(&mut *tx)
            .await
            .map_err(e)?;
            (id, true)
        }
    };
    sqlx::query("INSERT INTO mail_rule_seeds (mailbox_id, sender, rule_id) VALUES ($1,$2,$3)")
        .bind(s.mailbox_id)
        .bind(s.sender)
        .bind(&rule_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    tx.commit().await.map_err(e)?;
    Ok(inserted)
}

// ---------- Reads folder migration ----------

/// What it takes to make `Reads` a top-level folder.
#[derive(Debug, PartialEq)]
pub enum ReadsStep {
    /// Top-level Reads exists and there is nothing to merge.
    Done,
    /// No Reads anywhere: create it.
    Create,
    /// Only `INBOX<d>Reads` exists: rename it to `Reads`.
    Rename { from: String },
    /// Both exist and the old one still has mail: move it over, keep the old folder.
    Merge { from: String },
}

pub fn reads_step(folders: &[ImapFolder]) -> ReadsStep {
    let top = folders.iter().any(|f| f.path == READS || f.raw_path == READS);
    let legacy = folders.iter().find(|f| {
        let d = if f.delimiter.is_empty() { "." } else { f.delimiter.as_str() };
        let want = format!("INBOX{d}{READS}");
        f.path.eq_ignore_ascii_case(&want) || f.raw_path.eq_ignore_ascii_case(&want)
    });
    match (top, legacy) {
        (true, Some(l)) if l.exists > 0 => ReadsStep::Merge { from: l.raw_path.clone() },
        (true, _) => ReadsStep::Done,
        (false, Some(l)) => ReadsStep::Rename { from: l.raw_path.clone() },
        (false, None) => ReadsStep::Create,
    }
}

async fn reads_done(state: &AppState, id: &str) -> bool {
    let mut c = state.control.lock().await;
    sqlx::query_scalar::<_, i64>("SELECT done_at FROM reads_migration WHERE mailbox_id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Make sure the mailbox has a top-level `Reads` folder, converting an old
/// `INBOX.Reads`. Never deletes a folder or a message. Recorded once it
/// succeeds; on any failure it is retried on the next pass.
pub async fn ensure_reads(state: &AppState, mb: &MailboxCreds, prio: Priority) -> Result<(), String> {
    if reads_done(state, &mb.id).await {
        return Ok(());
    }
    let folders = ops::imap_list_folders(mb.imap.clone(), prio).await?;
    match reads_step(&folders) {
        ReadsStep::Done => {}
        ReadsStep::Create => ops::imap_create_folder(mb.imap.clone(), READS.into(), prio).await?,
        ReadsStep::Rename { from } => ops::imap_rename_folder(mb.imap.clone(), from, READS.into(), prio).await?,
        ReadsStep::Merge { from } => {
            let uids = ops::imap_search_all_uids(mb.imap.clone(), from.clone(), prio).await?;
            for chunk in uids.chunks(FETCH_CHUNK) {
                ops::imap_move_messages(mb.imap.clone(), from.clone(), chunk.to_vec(), READS.into(), prio).await?;
            }
        }
    }
    // Only count it done when the server really has a top-level Reads now.
    let after = ops::imap_list_folders(mb.imap.clone(), prio).await?;
    if !after.iter().any(|f| f.path == READS || f.raw_path == READS) {
        return Err(format!("{}: top-level Reads is still missing after migration", mb.email));
    }
    let mut c = state.control.lock().await;
    sqlx::query("INSERT OR REPLACE INTO reads_migration (mailbox_id, done_at) VALUES ($1,$2)")
        .bind(&mb.id)
        .bind(chrono_now())
        .execute(&mut *c)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!("mail rules: {} now has a top-level Reads folder", mb.email);
    Ok(())
}

// ---------- running ----------

/// Carry out a plan. Flags first, then moves, so a message is marked before it
/// leaves. A failing group does not stop the others; failures are reported
/// together and the affected mail simply stays where it is.
pub async fn execute(state: &AppState, creds: &MailboxCreds, folder: &str, p: &Plan, prio: Priority) -> Result<(), String> {
    if !p.mark_read.is_empty() {
        ops::imap_set_flags(creds.imap.clone(), folder.into(), p.mark_read.clone(), vec!["\\Seen".into()], true, prio).await?;
    }
    if !p.star.is_empty() {
        ops::imap_set_flags(creds.imap.clone(), folder.into(), p.star.clone(), vec!["\\Flagged".into()], true, prio).await?;
    }
    if p.moves.is_empty() && p.transfers.is_empty() && p.trash.is_empty() {
        return Ok(());
    }
    let own = ops::imap_list_folders(creds.imap.clone(), prio).await?;
    let mut failures: Vec<String> = Vec::new();

    for (dest, uids) in &p.moves {
        let moved = match checked_dest(&own, dest, &creds.email) {
            Ok(raw) => ops::imap_move_messages(creds.imap.clone(), folder.into(), uids.clone(), raw, prio).await,
            Err(e) => Err(e),
        };
        if let Err(e) = moved {
            failures.push(e);
        }
    }

    if !p.trash.is_empty() {
        let moved = match trash_folder(&own) {
            None => Err(format!("{} has no Trash folder; nothing was moved or deleted", creds.email)),
            Some(t) if resolve_folder(&own, folder).as_deref() == Some(t.as_str()) => Ok(()), // already in Trash
            Some(t) => ops::imap_move_messages(creds.imap.clone(), folder.into(), p.trash.clone(), t, prio).await,
        };
        if let Err(e) = moved {
            failures.push(e);
        }
    }

    if !p.transfers.is_empty() {
        let all = mailboxes::all_with_creds(state).await;
        for ((dest_id, dest_folder), uids) in &p.transfers {
            let result = async {
                let dest = all.iter().find(|m| &m.id == dest_id).ok_or("Destination mailbox no longer exists")?;
                let folders = ops::imap_list_folders(dest.imap.clone(), prio).await?;
                let raw = checked_dest(&folders, dest_folder, &dest.email)?;
                let out = crate::transfer::transfer_messages(state, creds, folder, uids, dest, &raw).await?;
                tracing::info!("mail rules: {} → {}/{raw}: {out:?}", creds.email, dest.email);
                if out.failed > 0 || out.flagged_only > 0 || out.missing > 0 {
                    return Err(format!("Cross-mailbox move incomplete: {} failed, {} source copies only flagged, {} missing; completed moves are retained and transfers are journaled for retry", out.failed, out.flagged_only, out.missing));
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(e) = result {
                failures.push(e);
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

async fn headers(creds: &MailboxCreds, folder: &str, uids: &[u32], prio: Priority) -> Result<Vec<ImapMessage>, String> {
    let mut out = Vec::new();
    for chunk in uids.chunks(FETCH_CHUNK) {
        out.extend(ops::imap_fetch_messages(creds.imap.clone(), folder.into(), chunk.to_vec(), true, prio).await?.messages);
    }
    Ok(out)
}

/// Run the mailbox's rules over the newest `limit` messages, or all existing
/// messages when `all_history` is true. New arrivals are outside this snapshot.
pub async fn apply_now(state: &AppState, creds: &MailboxCreds, folder: &str, limit: usize, all_history: bool) -> Result<Value, String> {
    let rules = list(state, &creds.id).await;
    if rules.iter().all(|r| r.enabled == 0) {
        return Ok(json!({ "checked": 0, "moved": 0, "trashed": 0, "marked_read": 0, "starred": 0, "note": "No enabled rules" }));
    }
    ensure_reads(state, creds, Priority::Interactive).await?;
    let mut uids = ops::imap_search_all_uids(creds.imap.clone(), folder.into(), Priority::Interactive).await?;
    uids.sort_unstable_by(|a, b| b.cmp(a));
    if !all_history {
        uids.truncate(limit.clamp(1, MAX_APPLY));
    }
    let (mut checked, mut moved, mut trashed, mut marked_read, mut starred) = (0, 0, 0, 0, 0);
    // Snapshot UIDs before any moves. Repeating a newest-message query would
    // revisit non-matches and flag-only matches, and could skip older mail.
    for batch in uids.chunks(FETCH_CHUNK) {
        let msgs = headers(creds, folder, batch, Priority::Interactive).await?;
        let p = plan(&rules, &msgs);
        execute(state, creds, folder, &p, Priority::Interactive).await?;
        checked += msgs.len();
        moved += p.moves.values().chain(p.transfers.values()).map(Vec::len).sum::<usize>();
        trashed += p.trash.len();
        marked_read += p.mark_read.len();
        starred += p.star.len();
    }
    Ok(json!({
        "checked": checked,
        "moved": moved,
        "trashed": trashed,
        "marked_read": marked_read,
        "starred": starred,
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

/// One pass over a mailbox. Reads is migrated first (every mailbox, retried until
/// it succeeds); until then nothing is filed, so no mail goes to an obsolete path.
pub async fn poll_mailbox(state: &AppState, mb: &MailboxCreds) -> Result<(), String> {
    ensure_reads(state, mb, Priority::Background)
        .await
        .map_err(|e| format!("Reads migration pending: {e}"))?;
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
            if let Err(e) = execute(state, mb, "INBOX", &p, Priority::Background).await {
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
            dest_mailbox_id: None,
            source: "agent".into(),
            trash_authorized_by: if action == "trash" { Some("g".into()) } else { None },
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
        let ok = NewRule { name: "n".into(), field: "from".into(), value: "x".into(), action: "move".into(), folder: Some("Reads".into()), dest_mailbox_id: None };
        assert!(validate(&ok).is_ok());
        let bad = |f: &dyn Fn(&mut NewRule)| {
            let mut r = NewRule { name: "n".into(), field: "from".into(), value: "x".into(), action: "move".into(), folder: Some("Reads".into()), dest_mailbox_id: None };
            f(&mut r);
            validate(&r).is_err()
        };
        assert!(bad(&|r| r.field = "body".into()));
        assert!(bad(&|r| r.action = "delete".into()));
        assert!(bad(&|r| r.folder = Some("INBOX.Trash".into())));
        assert!(bad(&|r| r.folder = Some("Deleted Items".into())));
        assert!(bad(&|r| { r.action = "trash".into(); }));
        assert!(!bad(&|r| { r.action = "trash".into(); r.folder = None; }));
        assert!(bad(&|r| r.value = "  ".into()));
        assert!(bad(&|r| r.folder = None));
        assert!(bad(&|r| { r.action = "star".into(); }));
        assert!(bad(&|r| r.name = "".into()));
        assert!(bad(&|r| { r.action = "star".into(); r.folder = None; r.dest_mailbox_id = Some("other".into()); }));
        assert!(!bad(&|r| r.dest_mailbox_id = Some("other".into())));
    }

    #[test]
    fn plan_routes_cross_mailbox_moves_to_transfers() {
        let mut x = rule("from", "boss@", "move", Some("INBOX"));
        x.dest_mailbox_id = Some("me".into());
        let mut same = rule("from", "self@", "move", Some("Reads"));
        same.dest_mailbox_id = Some("m".into()); // own mailbox id → plain MOVE
        let p = plan(&[x, same], &[msg(1, "boss@c.com", "a"), msg(2, "self@c.com", "b")]);
        assert_eq!(p.transfers.get(&("me".to_string(), "INBOX".to_string())), Some(&vec![1]));
        assert_eq!(p.moves.get("Reads"), Some(&vec![2]));
        assert!(!p.is_empty());
    }

    #[test]
    fn plan_trash_is_a_move_and_needs_stored_authorisation() {
        let rules = vec![
            rule("subject", "spam", "mark_read", None),
            rule("subject", "spam", "trash", None),
            rule("subject", "spam", "move", Some("Reads")),
        ];
        let p = plan(&rules, &[msg(1, "a@b.c", "spam spam")]);
        assert_eq!(p.trash, vec![1]);
        assert!(p.moves.is_empty());
        assert_eq!(p.mark_read, vec![1]);
        let mut unauthorised = rule("subject", "spam", "trash", None);
        unauthorised.trash_authorized_by = None;
        assert!(plan(&[unauthorised], &[msg(1, "a@b.c", "spam")]).is_empty());
    }

    #[test]
    fn plan_normalizes_inbox_reads() {
        let p = plan(&[rule("from", "n", "move", Some("INBOX.Reads"))], &[msg(1, "n@x.com", "")]);
        assert_eq!(p.moves.get("Reads"), Some(&vec![1]));
    }

    #[test]
    fn reads_and_trash_names() {
        assert_eq!(normalize_reads("INBOX.Reads"), "Reads");
        assert_eq!(normalize_reads(" inbox/reads "), "Reads");
        assert_eq!(normalize_reads("Reads"), "Reads");
        assert_eq!(normalize_reads("INBOX.Reads.Old"), "INBOX.Reads.Old");
        assert!(is_known_trash_name("INBOX.Trash"));
        assert!(is_known_trash_name("[Gmail]/Trash"));
        assert!(is_known_trash_name("Deleted Items"));
        assert!(!is_known_trash_name("Reads"));
    }

    fn folder(path: &str, delim: &str, special: Option<&str>, exists: u32) -> ImapFolder {
        ImapFolder {
            path: path.into(),
            raw_path: path.into(),
            name: path.rsplit(delim).next().unwrap().into(),
            delimiter: delim.into(),
            special_use: special.map(str::to_string),
            exists,
            unseen: 0,
        }
    }

    #[test]
    fn reads_migration_steps() {
        let inbox = folder("INBOX", ".", None, 3);
        assert_eq!(reads_step(&[inbox.clone()]), ReadsStep::Create);
        assert_eq!(
            reads_step(&[inbox.clone(), folder("INBOX.Reads", ".", None, 2)]),
            ReadsStep::Rename { from: "INBOX.Reads".into() }
        );
        assert_eq!(
            reads_step(&[inbox.clone(), folder("INBOX/Reads", "/", None, 2)]),
            ReadsStep::Rename { from: "INBOX/Reads".into() }
        );
        assert_eq!(
            reads_step(&[inbox.clone(), folder("INBOX.Reads", ".", None, 2), folder("Reads", ".", None, 0)]),
            ReadsStep::Merge { from: "INBOX.Reads".into() }
        );
        assert_eq!(
            reads_step(&[inbox.clone(), folder("INBOX.Reads", ".", None, 0), folder("Reads", ".", None, 5)]),
            ReadsStep::Done
        );
        assert_eq!(reads_step(&[inbox, folder("Reads", ".", None, 5)]), ReadsStep::Done);
    }

    #[test]
    fn trash_destinations_are_found_and_refused() {
        let fs = vec![
            folder("INBOX", ".", None, 0),
            folder("Corbeille", ".", Some("\\Trash"), 0),
            folder("Reads", ".", None, 0),
        ];
        assert_eq!(trash_folder(&fs).as_deref(), Some("Corbeille"));
        assert!(checked_dest(&fs, "Reads", "a@x").is_ok());
        assert!(checked_dest(&fs, "Corbeille", "a@x").is_err());
        assert!(checked_dest(&fs, "Missing", "a@x").is_err());
        assert_eq!(trash_folder(&[folder("INBOX.Trash", ".", None, 0)]).as_deref(), Some("INBOX.Trash"));
        assert_eq!(trash_folder(&[folder("INBOX", ".", None, 0)]), None);
    }

    async fn test_conn() -> (SqliteConnection, std::path::PathBuf) {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::ConnectOptions;
        use std::str::FromStr;
        let dir = std::env::temp_dir().join(format!("velo-rules-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("c.db");
        let conn = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
            .unwrap()
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        (conn, dir)
    }

    #[tokio::test]
    async fn upgrades_first_release_table_and_converts_legacy_filer() {
        let (mut c, _d) = test_conn().await;
        // First-release mail_rules (no trash action, no source/dest columns).
        sqlx::query(
            "CREATE TABLE mail_rules (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, name TEXT NOT NULL,              field TEXT NOT NULL CHECK (field IN ('from','to','subject')), value TEXT NOT NULL,              action TEXT NOT NULL CHECK (action IN ('move','mark_read','star')), folder TEXT,              enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)",
        )
        .execute(&mut c).await.unwrap();
        sqlx::query("INSERT INTO mail_rules VALUES ('keep','mb','Keep','subject','x','star',NULL,1,'g',5)")
            .execute(&mut c).await.unwrap();
        // Legacy filer data.
        sqlx::query(
            "CREATE TABLE filing_rules (id TEXT PRIMARY KEY, user_id TEXT, mailbox_id TEXT, sender_email TEXT,              action TEXT NOT NULL DEFAULT 'move_reads', enabled INTEGER NOT NULL DEFAULT 1, notify_before INTEGER NOT NULL DEFAULT 1,              created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, dest_mailbox_id TEXT, dest_folder TEXT)",
        )
        .execute(&mut c).await.unwrap();
        sqlx::query("CREATE TABLE filing_state (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, folder_path TEXT, last_uid INTEGER, last_notified_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0)")
            .execute(&mut c).await.unwrap();
        for (id, sender, action, enabled, df, dm, at) in [
            ("l1", "News@Letter.com", "move_reads", 1, None, None, 10),
            ("l2", "@sub.com", "move_reads", 0, None, None, 20),
            ("l3", "boss@c.com", "move", 1, Some("INBOX.Reads"), Some("other"), 30),
            ("l4", "*", "move", 0, Some("INBOX"), Some("other"), 5),
        ] {
            sqlx::query("INSERT INTO filing_rules (id,user_id,mailbox_id,sender_email,action,enabled,created_at,dest_mailbox_id,dest_folder) VALUES ($1,'u','mb',$2,$3,$4,$5,$6,$7)")
                .bind(id).bind(sender).bind(action).bind(enabled).bind(at).bind(dm).bind(df)
                .execute(&mut c).await.unwrap();
        }
        sqlx::query("INSERT INTO filing_state (id, mailbox_id, last_uid) VALUES ('mb','mb',77)").execute(&mut c).await.unwrap();

        migrate(&mut c).await;
        migrate(&mut c).await; // idempotent

        let rows: Vec<Rule> = sqlx::query_as("SELECT * FROM mail_rules ORDER BY created_at, id").fetch_all(&mut c).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["keep", "l1", "l2", "l3", "l4"], "catch-all sorts last: {ids:?}");
        let by = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by("keep").source, "agent");
        assert_eq!((by("l1").value.as_str(), by("l1").folder.as_deref(), by("l1").enabled), ("news@letter.com", Some("Reads"), 1));
        assert_eq!((by("l2").value.as_str(), by("l2").enabled), ("@sub.com", 0));
        assert_eq!((by("l3").folder.as_deref(), by("l3").dest_mailbox_id.as_deref()), (Some("Reads"), Some("other")));
        assert_eq!((by("l4").value.as_str(), by("l4").enabled, by("l4").source.as_str()), ("@", 0, "legacy_filer"));
        assert_eq!(by("l1").created_by, "u");
        let (last,): (i64,) = sqlx::query_as("SELECT last_uid FROM mail_rule_state WHERE mailbox_id='mb'").fetch_one(&mut c).await.unwrap();
        assert_eq!(last, 77);
        let (gone,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('filing_rules','filing_state')").fetch_one(&mut c).await.unwrap();
        assert_eq!(gone, 0);
        let (ledger,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mail_rule_seeds").fetch_one(&mut c).await.unwrap();
        assert_eq!(ledger, 4);
        // The rebuilt table accepts trash.
        sqlx::query("INSERT INTO mail_rules (id,mailbox_id,name,field,value,action,created_by,created_at) VALUES ('t','mb','T','from','x','trash','g',1)")
            .execute(&mut c).await.unwrap();
    }

    #[tokio::test]
    async fn legacy_migration_failure_keeps_old_tables() {
        let (mut c, _d) = test_conn().await;
        migrate(&mut c).await;
        sqlx::query("CREATE TABLE filing_rules (id TEXT PRIMARY KEY, mailbox_id TEXT, sender_email TEXT, action TEXT, enabled INTEGER, created_at INTEGER)")
            .execute(&mut c).await.unwrap();
        sqlx::query("INSERT INTO filing_rules VALUES ('a','mb','a@b.com','move_reads',1,1)").execute(&mut c).await.unwrap();
        // Make the conversion fail part-way: the ledger table is gone.
        sqlx::query("DROP TABLE mail_rule_seeds").execute(&mut c).await.unwrap();
        migrate_legacy(&mut c).await;
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM filing_rules").fetch_one(&mut c).await.unwrap();
        assert_eq!(n, 1);
        let (m,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mail_rules").fetch_one(&mut c).await.unwrap();
        assert_eq!(m, 0, "converted rows roll back with the failed transaction");
    }

    #[tokio::test]
    async fn seeds_import_once_and_survive_edits_and_deletes() {
        let (mut c, _d) = test_conn().await;
        migrate(&mut c).await;
        let seed = |sender: &'static str| SeedRule { mailbox_id: "mb", sender, folder: "INBOX.Reads", dest_mailbox_id: None, enabled: true, created_by: "seed" };
        assert!(seed_rule(&mut c, &seed("a@b.com")).await.unwrap());
        assert!(!seed_rule(&mut c, &seed("a@b.com")).await.unwrap());
        let (id, folder): (String, String) = sqlx::query_as("SELECT id, folder FROM mail_rules WHERE value='a@b.com'").fetch_one(&mut c).await.unwrap();
        assert_eq!(folder, "Reads");
        assert_eq!(id, seed_rule_id("mb", "a@b.com"));
        // Agent edits the condition and disables it: a restart must not add another.
        sqlx::query("UPDATE mail_rules SET value='zzz', enabled=0 WHERE id=$1").bind(&id).execute(&mut c).await.unwrap();
        assert!(!seed_rule(&mut c, &seed("a@b.com")).await.unwrap());
        // …nor after it is deleted.
        sqlx::query("DELETE FROM mail_rules WHERE id=$1").bind(&id).execute(&mut c).await.unwrap();
        assert!(!seed_rule(&mut c, &seed("a@b.com")).await.unwrap());
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mail_rules").fetch_one(&mut c).await.unwrap();
        assert_eq!(n, 0);
        // An existing sender rule (e.g. migrated) is adopted, not duplicated.
        sqlx::query("INSERT INTO mail_rules (id,mailbox_id,name,field,value,action,folder,created_by,created_at,source) VALUES ('old','mb','o','from','N@x.com','move','Reads','u',1,'legacy_filer')")
            .execute(&mut c).await.unwrap();
        assert!(!seed_rule(&mut c, &seed("n@x.com")).await.unwrap());
        let (rid,): (String,) = sqlx::query_as("SELECT rule_id FROM mail_rule_seeds WHERE sender='n@x.com'").fetch_one(&mut c).await.unwrap();
        assert_eq!(rid, "old");
        // Catch-all: from contains "@"; transfer seeds default disabled via the caller.
        let all = SeedRule { mailbox_id: "mb", sender: "*", folder: "INBOX", dest_mailbox_id: Some("me"), enabled: false, created_by: "seed" };
        assert!(seed_rule(&mut c, &all).await.unwrap());
        let (v, en): (String, i64) = sqlx::query_as("SELECT value, enabled FROM mail_rules WHERE value='@'").fetch_one(&mut c).await.unwrap();
        assert_eq!((v.as_str(), en), ("@", 0));
        // Same-mailbox INBOX and Trash targets are refused.
        let bad = SeedRule { mailbox_id: "mb", sender: "q@x.com", folder: "inbox", dest_mailbox_id: None, enabled: true, created_by: "seed" };
        assert!(seed_rule(&mut c, &bad).await.is_err());
        let trash = SeedRule { folder: "INBOX.Trash", ..bad };
        assert!(seed_rule(&mut c, &trash).await.is_err());
    }
}

/// Rule execution against local TCP IMAP fixtures (see `imap_fixture.rs`).
#[cfg(test)]
mod imap_tests {
    use super::*;
    use crate::imap_fixture::{message, Fixture};

    async fn state() -> AppState {
        let dir = std::env::temp_dir().join(format!("velo-imap-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::server_crypto::init_key(&dir.join("velo-secret.key"));
        AppState::init(dir.join("c.db").to_str().unwrap(), dir.clone()).await
    }

    async fn provision(state: &AppState, mb: &MailboxCreds) {
        let mut c = state.control.lock().await;
        sqlx::query("INSERT OR IGNORE INTO users (id,email,role,password_hash) VALUES ('owner','owner@fx','member','unused')")
            .execute(&mut *c).await.unwrap();
        sqlx::query("INSERT INTO mailboxes (id,owner_user_id,email,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,password_enc) VALUES ($1,'owner',$2,'127.0.0.1',$3,'none','127.0.0.1',1,'none','u',$4)")
            .bind(&mb.id).bind(&mb.email).bind(mb.imap.port as i64).bind(crate::server_crypto::encrypt("p"))
            .execute(&mut *c).await.unwrap();
    }

    #[tokio::test]
    async fn all_history_moves_old_matches_across_mailboxes_and_preserves_non_matches() {
        let st = state().await;
        let bodies = (0..225).map(|i| message(&format!("old-{i}"), "news@fx", if i % 2 == 0 { "file this" } else { "keep" })).collect();
        let src = Fixture::start(&[("INBOX", bodies), ("Reads", vec![])]).await;
        let dest = Fixture::start(&[("Filed", vec![])]).await;
        let (mb, target) = (src.creds("src"), dest.creds("target"));
        provision(&st, &target).await;
        create(&st, &mb.id, "test", &NewRule {
            name: "File by subject".into(), field: "subject".into(), value: "file this".into(),
            action: "move".into(), folder: Some("Filed".into()), dest_mailbox_id: Some(target.id.clone()),
        }, None).await.unwrap();
        // Creation alone never moves old mail.
        assert_eq!(src.count("INBOX"), Some(225));
        let limited = apply_now(&st, &mb, "INBOX", 400, false).await.unwrap();
        assert_eq!(limited["checked"], 200);
        assert_eq!(limited["moved"], 100);
        // Snapshot includes remaining non-matches and matches older than the cap.
        let all = apply_now(&st, &mb, "INBOX", 1, true).await.unwrap();
        assert_eq!(all["checked"], 125);
        assert_eq!(all["moved"], 13);
        assert_eq!(src.count("INBOX"), Some(112));
        assert_eq!(dest.count("Filed"), Some(113));
        let again = apply_now(&st, &mb, "INBOX", 1, true).await.unwrap();
        assert_eq!(again["checked"], 112);
        assert_eq!(again["moved"], 0);
        assert_eq!(dest.count("Filed"), Some(113));
    }

    #[tokio::test]
    async fn all_history_checks_every_message_and_reuses_flag_rules() {
        let st = state().await;
        let bodies = (0..225).map(|i| message(&format!("flag-{i}"), "news@fx", "hello")).collect();
        let src = Fixture::start(&[("Archive", bodies), ("INBOX", vec![]), ("Reads", vec![])]).await;
        let mb = src.creds("flags");
        for action in ["star", "mark_read"] {
            create(&st, &mb.id, "test", &NewRule {
                name: action.into(), field: "to".into(), value: "me@fx".into(),
                action: action.into(), folder: None, dest_mailbox_id: None,
            }, None).await.unwrap();
        }
        let out = apply_now(&st, &mb, "Archive", 1, true).await.unwrap();
        assert_eq!(out["checked"], 225);
        assert_eq!(out["starred"], 225);
        assert_eq!(out["marked_read"], 225);
        assert_eq!(src.count("Archive"), Some(225));
        let srv = src.srv.lock().unwrap();
        assert!(srv.folders["Archive"].iter().all(|m| m.flags.contains("Seen") && m.flags.contains("Flagged")));
    }

    #[tokio::test]
    async fn all_history_reports_transfer_failure_and_can_retry() {
        let st = state().await;
        let src = Fixture::start(&[("INBOX", vec![message("failure", "news@fx", "file")]), ("Reads", vec![])]).await;
        let dest = Fixture::start(&[("Filed", vec![])]).await;
        let (mb, target) = (src.creds("failure-src"), dest.creds("failure-dest"));
        provision(&st, &target).await;
        create(&st, &mb.id, "test", &NewRule {
            name: "News".into(), field: "from".into(), value: "news@fx".into(),
            action: "move".into(), folder: Some("Filed".into()), dest_mailbox_id: Some(target.id.clone()),
        }, None).await.unwrap();
        dest.srv.lock().unwrap().fail_append = true;
        let err = apply_now(&st, &mb, "INBOX", 1, true).await.unwrap_err();
        assert!(err.contains("1 failed"), "{err}");
        assert_eq!(src.count("INBOX"), Some(1));
        assert_eq!(dest.count("Filed"), Some(0));
        dest.srv.lock().unwrap().fail_append = false;
        let out = apply_now(&st, &mb, "INBOX", 1, true).await.unwrap();
        assert_eq!(out["moved"], 1);
        assert_eq!(src.count("INBOX"), Some(0));
        assert_eq!(dest.count("Filed"), Some(1));
    }

    async fn migrated(state: &AppState, id: &str) -> bool {
        reads_done(state, id).await
    }

    #[tokio::test]
    async fn inbox_reads_is_renamed_to_top_level_reads() {
        let st = state().await;
        let fx = Fixture::start(&[("INBOX", vec![]), ("INBOX.Reads", vec![message("a", "n@x.com", "one"), message("b", "n@x.com", "two")])]).await;
        let mb = fx.creds("rename");
        ensure_reads(&st, &mb, Priority::Interactive).await.unwrap();
        assert_eq!(fx.names(), vec!["INBOX", "Reads"]);
        assert_eq!(fx.count("Reads"), Some(2), "mail came along with the rename");
        assert!(migrated(&st, "rename").await);
        // Done once: a second call does not touch the server again.
        let before = fx.srv.lock().unwrap().log.len();
        ensure_reads(&st, &mb, Priority::Interactive).await.unwrap();
        assert_eq!(fx.srv.lock().unwrap().log.len(), before);
    }

    #[tokio::test]
    async fn both_reads_folders_are_merged_and_the_old_one_is_kept() {
        let st = state().await;
        let fx = Fixture::start(&[
            ("INBOX", vec![]),
            ("INBOX.Reads", vec![message("a", "n@x.com", "old1"), message("b", "n@x.com", "old2")]),
            ("Reads", vec![message("c", "n@x.com", "new")]),
        ])
        .await;
        ensure_reads(&st, &fx.creds("merge"), Priority::Interactive).await.unwrap();
        assert_eq!(fx.count("Reads"), Some(3));
        assert_eq!(fx.count("INBOX.Reads"), Some(0), "old folder retained, emptied");
        assert!(fx.names().contains(&"INBOX.Reads".to_string()));
        assert!(migrated(&st, "merge").await);
    }

    #[tokio::test]
    async fn missing_reads_is_created() {
        let st = state().await;
        let fx = Fixture::start(&[("INBOX", vec![message("a", "x@y.com", "hi")])]).await;
        ensure_reads(&st, &fx.creds("create"), Priority::Interactive).await.unwrap();
        assert_eq!(fx.names(), vec!["INBOX", "Reads"]);
        assert_eq!(fx.count("INBOX"), Some(1));
    }

    #[tokio::test]
    async fn failed_reads_migration_deletes_nothing_waits_and_retries() {
        let st = state().await;
        let fx = Fixture::start(&[("INBOX", vec![]), ("INBOX.Reads", vec![message("a", "n@x.com", "one")])]).await;
        fx.srv.lock().unwrap().fail_rename = true;
        let mb = fx.creds("retry");
        assert!(ensure_reads(&st, &mb, Priority::Interactive).await.is_err());
        assert!(!migrated(&st, "retry").await);
        assert_eq!(fx.count("INBOX.Reads"), Some(1), "nothing lost");
        // Rule polling waits for the migration: it reports pending and files nothing.
        let e = poll_mailbox(&st, &mb).await.unwrap_err();
        assert!(e.contains("Reads migration pending"), "{e}");
        fx.srv.lock().unwrap().fail_rename = false;
        ensure_reads(&st, &mb, Priority::Interactive).await.unwrap();
        assert_eq!(fx.count("Reads"), Some(1));
        assert!(migrated(&st, "retry").await);
    }

    #[tokio::test]
    async fn trash_action_moves_to_the_special_use_trash_and_never_expunges() {
        let st = state().await;
        let fx = Fixture::start(&[
            ("INBOX", vec![message("a", "s@x.com", "spam"), message("b", "k@x.com", "keep")]),
            ("Corbeille", vec![]),
            ("Reads", vec![]),
        ])
        .await;
        fx.srv.lock().unwrap().trash.push("Corbeille".into());
        let mb = fx.creds("trash");
        let p = Plan { trash: vec![1], ..Default::default() };
        execute(&st, &mb, "INBOX", &p, Priority::Interactive).await.unwrap();
        assert_eq!(fx.count("Corbeille"), Some(1));
        assert_eq!(fx.uids("INBOX").len(), 1);
        assert!(!fx.srv.lock().unwrap().log.iter().any(|l| l.starts_with("EXPUNGE")));

        // A plain move into the (localized, special-use) Trash is refused; mail stays.
        let mut p = Plan::default();
        p.moves.insert("Corbeille".into(), fx.uids("INBOX"));
        let e = execute(&st, &mb, "INBOX", &p, Priority::Interactive).await.unwrap_err();
        assert!(e.contains("Trash"), "{e}");
        assert_eq!(fx.count("INBOX"), Some(1));
        assert_eq!(fx.count("Corbeille"), Some(1));
        // Ordinary moves still work.
        let mut p = Plan::default();
        p.moves.insert("Reads".into(), fx.uids("INBOX"));
        execute(&st, &mb, "INBOX", &p, Priority::Interactive).await.unwrap();
        assert_eq!(fx.count("Reads"), Some(1));
    }

    #[tokio::test]
    async fn trash_without_a_trash_folder_fails_without_deleting() {
        let st = state().await;
        let fx = Fixture::start(&[("INBOX", vec![message("a", "s@x.com", "spam")])]).await;
        let p = Plan { trash: vec![1], ..Default::default() };
        let e = execute(&st, &fx.creds("notrash"), "INBOX", &p, Priority::Interactive).await.unwrap_err();
        assert!(e.contains("no Trash folder"), "{e}");
        assert_eq!(fx.count("INBOX"), Some(1));
    }

    #[tokio::test]
    async fn cross_mailbox_move_appends_before_removing_and_failed_append_keeps_source() {
        let st = state().await;
        let work = Fixture::start(&[("INBOX", vec![message("a", "boss@c.com", "do it"), message("b", "boss@c.com", "now")])]).await;
        let home = Fixture::start(&[("INBOX", vec![]), ("Reads", vec![])]).await;
        let (w, h) = (work.creds("work"), home.creds("home"));

        // APPEND refused → the source copy is untouched.
        home.srv.lock().unwrap().fail_append = true;
        let out = crate::transfer::transfer_messages(&st, &w, "INBOX", &[1, 2], &h, "INBOX").await.unwrap();
        assert_eq!(out.failed, 2);
        assert_eq!(work.count("INBOX"), Some(2));
        assert_eq!(home.count("INBOX"), Some(0));
        assert!(!work.srv.lock().unwrap().log.iter().any(|l| l.starts_with("EXPUNGE")));

        // Working destination: append first, then the source UID goes.
        home.srv.lock().unwrap().fail_append = false;
        let out = crate::transfer::transfer_messages(&st, &w, "INBOX", &[1, 2], &h, "INBOX").await.unwrap();
        assert_eq!(out.moved, 2, "{out:?}");
        assert_eq!(home.count("INBOX"), Some(2));
        assert_eq!(work.count("INBOX"), Some(0));
        let log = work.srv.lock().unwrap().log.clone();
        assert!(log.iter().any(|l| l.starts_with("EXPUNGE INBOX 1")), "{log:?}");

        // A rule plan routes through the same path and refuses Trash destinations.
        let w2 = Fixture::start(&[("INBOX", vec![message("c", "boss@c.com", "x")])]).await;
        let mut p = Plan::default();
        p.transfers.insert(("home".into(), "INBOX".into()), vec![1]);
        // `execute` finds the destination mailbox by id among provisioned mailboxes (none in this
        // throwaway control DB), so it reports that instead of touching either server.
        let e = execute(&st, &w2.creds("w2"), "INBOX", &p, Priority::Interactive).await.unwrap_err();
        assert!(e.contains("Destination mailbox no longer exists"), "{e}");
        assert_eq!(w2.count("INBOX"), Some(1));
    }
}
