//! Agent access: scoped, expiring passphrases and the MCP endpoint they open.
//!
//! An admin mints a passphrase in Settings → Admin. Each one names the
//! mailboxes it may reach, whether it may send and organise mail or only read,
//! whether permanent deletion is blocked, and when it expires. The agent sends
//! it as `Authorization: Bearer <passphrase>` to `POST /mcp`; no account login
//! is ever shared with an agent.
//!
//! Only a SHA-256 of the passphrase is stored (it carries 256 bits of
//! randomness, so a fast hash is enough). Every tool call is written to
//! `agent_audit` with the tool, mailbox and outcome — never message content.

use axum::{
    body::Bytes,
    extract::{Json, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Extension, Router,
};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use velo_core::imap::scheduler::Priority;
use velo_core::ops;

use crate::mail_rules;
use crate::mailboxes;
use crate::state::{new_id, AppState, User};

const PASSPHRASE_PREFIX: &str = "vpk_";
const MIN_LIFETIME_SECS: i64 = 60;
const MAX_LIFETIME_SECS: i64 = 90 * 24 * 3600;
const MAX_BODY_CHARS: usize = 60_000;
const MAX_PAGE: usize = 50;

pub const SCOPE_READ: &str = "read";
pub const SCOPE_READ_SEND: &str = "read_send";

// ---------- schema ----------

pub async fn migrate(conn: &mut sqlx::SqliteConnection) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_passphrases (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            secret_hash TEXT NOT NULL UNIQUE,
            hint TEXT NOT NULL,
            scope TEXT NOT NULL CHECK (scope IN ('read','read_send')),
            block_destructive INTEGER NOT NULL DEFAULT 1,
            mailbox_ids TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER,
            last_used_at INTEGER
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create agent_passphrases table failed");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS agent_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            passphrase_id TEXT NOT NULL,
            at INTEGER NOT NULL,
            tool TEXT NOT NULL,
            mailbox_id TEXT,
            outcome TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT ''
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create agent_audit table failed");
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hash_secret(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn new_passphrase() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{PASSPHRASE_PREFIX}{hex}")
}

// ---------- grants and what they allow ----------

/// What a presented passphrase is allowed to do.
#[derive(Clone, Debug)]
pub struct Grant {
    pub id: String,
    pub scope: String,
    pub block_destructive: bool,
    pub mailbox_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Reading and listing only.
    Read,
    /// Sending mail, marking, filing and moving.
    Write,
    /// Permanent deletion: the `\Deleted` flag or an expunge.
    Destructive,
}

/// Whether `grant` may perform an action of this kind.
pub fn permits(grant: &Grant, kind: Kind) -> Result<(), String> {
    match kind {
        Kind::Read => Ok(()),
        Kind::Write if grant.scope == SCOPE_READ_SEND => Ok(()),
        Kind::Write => Err("This passphrase is read-only".to_string()),
        Kind::Destructive if grant.scope != SCOPE_READ_SEND => {
            Err("This passphrase is read-only".to_string())
        }
        Kind::Destructive if grant.block_destructive => {
            Err("Permanent deletion is blocked for this passphrase".to_string())
        }
        Kind::Destructive => Ok(()),
    }
}

/// Setting or clearing a flag is organising unless it adds `\Deleted`.
fn flag_change_kind(flags: &[String], add: bool) -> Kind {
    let deleted = flags
        .iter()
        .any(|f| f.trim_start_matches('\\').eq_ignore_ascii_case("deleted"));
    if deleted && add {
        Kind::Destructive
    } else {
        Kind::Write
    }
}

/// Match an agent-supplied mailbox (id or address) against what the grant lists.
async fn pick_mailbox(
    state: &AppState,
    grant: &Grant,
    wanted: &str,
) -> Result<mailboxes::MailboxCreds, String> {
    let wanted = wanted.trim();
    for id in &grant.mailbox_ids {
        if let Ok(creds) = mailboxes::creds_for(state, id).await {
            if creds.id == wanted || creds.email.eq_ignore_ascii_case(wanted) {
                return Ok(creds);
            }
        }
    }
    Err("This passphrase cannot use that mailbox".to_string())
}

// ---------- admin API (guarded by require_admin) ----------

pub fn admin_router(state: AppState) -> Router {
    Router::new()
        .route("/agent-access/passphrases", get(list).post(mint))
        .route("/agent-access/passphrases/:id", delete(revoke))
        .route("/agent-access/audit", get(audit))
        .with_state(state)
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    label: String,
    hint: String,
    scope: String,
    block_destructive: i64,
    mailbox_ids: String,
    created_by: String,
    created_at: i64,
    expires_at: i64,
    revoked_at: Option<i64>,
    last_used_at: Option<i64>,
}

#[derive(Serialize)]
struct View {
    id: String,
    label: String,
    hint: String,
    scope: String,
    #[serde(rename = "blockDestructive")]
    block_destructive: bool,
    #[serde(rename = "mailboxIds")]
    mailbox_ids: Vec<String>,
    #[serde(rename = "createdBy")]
    created_by: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    #[serde(rename = "revokedAt")]
    revoked_at: Option<i64>,
    #[serde(rename = "lastUsedAt")]
    last_used_at: Option<i64>,
    status: &'static str,
}

fn view(r: Row, at: i64) -> View {
    let status = if r.revoked_at.is_some() {
        "revoked"
    } else if r.expires_at <= at {
        "expired"
    } else {
        "active"
    };
    View {
        id: r.id,
        label: r.label,
        hint: r.hint,
        scope: r.scope,
        block_destructive: r.block_destructive != 0,
        mailbox_ids: serde_json::from_str(&r.mailbox_ids).unwrap_or_default(),
        created_by: r.created_by,
        created_at: r.created_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        last_used_at: r.last_used_at,
        status,
    }
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

async fn list(State(state): State<AppState>) -> Response {
    let mut control = state.control.lock().await;
    let rows = sqlx::query_as::<_, Row>(
        "SELECT id, label, hint, scope, block_destructive, mailbox_ids, created_by, created_at, \
         expires_at, revoked_at, last_used_at FROM agent_passphrases \
         ORDER BY created_at DESC LIMIT 200",
    )
    .fetch_all(&mut *control)
    .await
    .unwrap_or_default();
    let at = now();
    Json(rows.into_iter().map(|r| view(r, at)).collect::<Vec<_>>()).into_response()
}

#[derive(Deserialize)]
struct MintReq {
    label: String,
    scope: String,
    #[serde(rename = "blockDestructive", default = "yes")]
    block_destructive: bool,
    #[serde(rename = "mailboxIds")]
    mailbox_ids: Vec<String>,
    #[serde(rename = "expiresInSeconds")]
    expires_in_seconds: i64,
}

fn yes() -> bool {
    true
}

async fn mint(
    State(state): State<AppState>,
    Extension(admin): Extension<User>,
    Json(req): Json<MintReq>,
) -> Response {
    let label = req.label.trim();
    if label.is_empty() || label.chars().count() > 80 {
        return err(StatusCode::BAD_REQUEST, "Give the agent a name of up to 80 characters");
    }
    if req.scope != SCOPE_READ && req.scope != SCOPE_READ_SEND {
        return err(StatusCode::BAD_REQUEST, "Scope must be read or read_send");
    }
    if req.mailbox_ids.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Choose at least one mailbox");
    }
    if req.expires_in_seconds < MIN_LIFETIME_SECS || req.expires_in_seconds > MAX_LIFETIME_SECS {
        return err(StatusCode::BAD_REQUEST, "Expiry must be between 1 minute and 90 days");
    }
    let mut ids: Vec<String> = Vec::new();
    for id in &req.mailbox_ids {
        if !mailboxes::exists(&state, id).await {
            return err(StatusCode::BAD_REQUEST, "One of the mailboxes does not exist");
        }
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }

    let passphrase = new_passphrase();
    let id = new_id();
    let created = now();
    let expires = created + req.expires_in_seconds;
    let hint = format!("…{}", &passphrase[passphrase.len() - 4..]);
    let mut control = state.control.lock().await;
    let result = sqlx::query(
        "INSERT INTO agent_passphrases (id, label, secret_hash, hint, scope, block_destructive, \
         mailbox_ids, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(&id)
    .bind(label)
    .bind(hash_secret(&passphrase))
    .bind(&hint)
    .bind(&req.scope)
    .bind(if req.block_destructive { 1 } else { 0 })
    .bind(serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()))
    .bind(&admin.email)
    .bind(created)
    .bind(expires)
    .execute(&mut *control)
    .await;
    match result {
        // The passphrase is returned this once and never stored in the clear.
        Ok(_) => Json(json!({ "id": id, "passphrase": passphrase, "expiresAt": expires })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not save the passphrase: {e}")),
    }
}

async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut control = state.control.lock().await;
    let done = sqlx::query(
        "UPDATE agent_passphrases SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
    )
    .bind(now())
    .bind(&id)
    .execute(&mut *control)
    .await;
    match done {
        Ok(r) if r.rows_affected() > 0 => Json(json!({ "ok": true })).into_response(),
        _ => err(StatusCode::NOT_FOUND, "No active passphrase with that id"),
    }
}

#[derive(Deserialize)]
struct AuditQuery {
    limit: Option<i64>,
}

#[derive(sqlx::FromRow, Serialize)]
struct AuditRow {
    id: i64,
    #[serde(rename = "passphraseId")]
    passphrase_id: String,
    label: Option<String>,
    at: i64,
    tool: String,
    #[serde(rename = "mailboxId")]
    mailbox_id: Option<String>,
    outcome: String,
    detail: String,
}

async fn audit(State(state): State<AppState>, Query(q): Query<AuditQuery>) -> Response {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let mut control = state.control.lock().await;
    let rows = sqlx::query_as::<_, AuditRow>(
        "SELECT a.id, a.passphrase_id, p.label, a.at, a.tool, a.mailbox_id, a.outcome, a.detail \
         FROM agent_audit a LEFT JOIN agent_passphrases p ON p.id = a.passphrase_id \
         ORDER BY a.id DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *control)
    .await
    .unwrap_or_default();
    Json(rows).into_response()
}

// ---------- MCP endpoint ----------

pub fn mcp_router(state: AppState) -> Router {
    Router::new()
        .route("/mcp", post(mcp_post).get(mcp_get).delete(mcp_delete))
        .with_state(state)
}

async fn mcp_get() -> Response {
    // No server-initiated stream: the spec allows refusing GET.
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

async fn mcp_delete() -> Response {
    // Stateless: there is no session to end.
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

fn unauthorized(msg: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(json!({ "error": msg })),
    )
        .into_response()
}

/// Look up the grant behind an `Authorization: Bearer` header, or say why not.
async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Grant, &'static str> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("Missing passphrase")?;
    let hash = hash_secret(token);
    let mut control = state.control.lock().await;
    let row: Option<(String, String, i64, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, scope, block_destructive, mailbox_ids, expires_at, revoked_at \
         FROM agent_passphrases WHERE secret_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&mut *control)
    .await
    .ok()
    .flatten();
    let (id, scope, block, mailbox_ids, expires_at, revoked_at) = row.ok_or("Unknown passphrase")?;
    if revoked_at.is_some() {
        return Err("This passphrase was revoked");
    }
    let at = now();
    if expires_at <= at {
        return Err("This passphrase has expired");
    }
    let _ = sqlx::query("UPDATE agent_passphrases SET last_used_at = $1 WHERE id = $2")
        .bind(at)
        .bind(&id)
        .execute(&mut *control)
        .await;
    Ok(Grant {
        id,
        scope,
        block_destructive: block != 0,
        mailbox_ids: serde_json::from_str(&mailbox_ids).unwrap_or_default(),
    })
}

async fn record(state: &AppState, grant: &Grant, tool: &str, mailbox: Option<&str>, outcome: &str, detail: &str) {
    let mut control = state.control.lock().await;
    let _ = sqlx::query(
        "INSERT INTO agent_audit (passphrase_id, at, tool, mailbox_id, outcome, detail) \
         VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(&grant.id)
    .bind(now())
    .bind(tool)
    .bind(mailbox)
    .bind(outcome)
    .bind(detail.chars().take(300).collect::<String>())
    .execute(&mut *control)
    .await;
}

const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

async fn mcp_post(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let grant = match authenticate(&state, &headers).await {
        Ok(g) => g,
        Err(msg) => return unauthorized(msg),
    };
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return rpc_error_response(Value::Null, -32700, "Parse error"),
    };
    if let Value::Array(items) = parsed {
        let mut out = Vec::new();
        for item in items {
            if let Some(r) = handle_rpc(&state, &grant, item).await {
                out.push(r);
            }
        }
        return if out.is_empty() {
            StatusCode::ACCEPTED.into_response()
        } else {
            Json(Value::Array(out)).into_response()
        };
    }
    match handle_rpc(&state, &grant, parsed).await {
        Some(r) => Json(r).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_error_response(id: Value, code: i64, message: &str) -> Response {
    Json(rpc_error(id, code, message)).into_response()
}

/// Handle one JSON-RPC message. Notifications (no id) return None.
async fn handle_rpc(state: &AppState, grant: &Grant, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = match id {
        Some(id) => id,
        None => return None, // notification, e.g. notifications/initialized
    };
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = SUPPORTED_PROTOCOLS
                .iter()
                .find(|v| **v == asked)
                .copied()
                .unwrap_or(SUPPORTED_PROTOCOLS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "velo-mcp", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Email access through Velo. Call list_mailboxes first; every other tool takes a mailbox id or address from it."
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_list(grant) }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            call_tool(state, grant, &name, &args).await
        }
        _ => return Some(rpc_error(id, -32601, "Method not found")),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

// ---------- tools ----------

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

/// Only the tools this passphrase can use, so a read-only agent never sees a send tool.
fn tool_list(grant: &Grant) -> Vec<Value> {
    let mailbox = json!({ "type": "string", "description": "Mailbox id or address from list_mailboxes" });
    let folder = json!({ "type": "string", "description": "Folder path, e.g. INBOX" });
    let mut tools = vec![
        tool("list_mailboxes", "List the mailboxes this passphrase can use.", json!({}), &[]),
        tool(
            "list_folders",
            "List a mailbox's folders with message and unread counts.",
            json!({ "mailbox": mailbox }),
            &["mailbox"],
        ),
        tool(
            "list_messages",
            "List the newest messages in a folder (headers only), newest first.",
            json!({
                "mailbox": mailbox, "folder": folder,
                "limit": { "type": "integer", "description": "How many, up to 50 (default 20)" },
                "before_uid": { "type": "integer", "description": "Only messages older than this uid, to page back" }
            }),
            &["mailbox"],
        ),
        tool(
            "list_rules",
            "List the inbox rules set up on a mailbox.",
            json!({ "mailbox": mailbox }),
            &["mailbox"],
        ),
        tool(
            "read_message",
            "Read one message: headers, text body and attachment names.",
            json!({ "mailbox": mailbox, "folder": folder, "uid": { "type": "integer" } }),
            &["mailbox", "folder", "uid"],
        ),
    ];
    if permits(grant, Kind::Write).is_ok() {
        tools.push(tool(
            "send_message",
            "Send a plain-text email from the mailbox.",
            json!({
                "mailbox": mailbox,
                "to": { "type": "array", "items": { "type": "string" } },
                "cc": { "type": "array", "items": { "type": "string" } },
                "subject": { "type": "string" },
                "body": { "type": "string" },
                "in_reply_to": { "type": "string", "description": "Message-ID being replied to" }
            }),
            &["mailbox", "to", "subject", "body"],
        ));
        tools.push(tool(
            "set_flags",
            "Mark messages read/unread, starred or answered. Flags: \\Seen, \\Flagged, \\Answered.",
            json!({
                "mailbox": mailbox, "folder": folder,
                "uids": { "type": "array", "items": { "type": "integer" } },
                "flags": { "type": "array", "items": { "type": "string" } },
                "add": { "type": "boolean", "description": "true to set, false to clear" }
            }),
            &["mailbox", "folder", "uids", "flags", "add"],
        ));
        tools.push(tool(
            "create_rule",
            "Add an inbox rule: when a message's from/to/subject contains some text, move it to a folder, mark it read, or star it. Rules run on new mail and never delete.",
            json!({
                "mailbox": mailbox,
                "name": { "type": "string", "description": "Short label for the rule" },
                "field": { "type": "string", "enum": ["from", "to", "subject"] },
                "value": { "type": "string", "description": "Matches when the field contains this text (any case)" },
                "action": { "type": "string", "enum": ["move", "mark_read", "star"] },
                "folder": { "type": "string", "description": "Destination folder; only for move" },
                "dest_mailbox": { "type": "string", "description": "Optional: id or email of ANOTHER mailbox this passphrase can use; the message is moved into its 'folder' (Apple Mail style: copied there, then removed here). Only for move" }
            }),
            &["mailbox", "name", "field", "value", "action"],
        ));
        tools.push(tool(
            "update_rule",
            "Change an existing rule (give all its fields again) or switch it off with enabled=false.",
            json!({
                "mailbox": mailbox, "rule_id": { "type": "string" },
                "name": { "type": "string" },
                "field": { "type": "string", "enum": ["from", "to", "subject"] },
                "value": { "type": "string" },
                "action": { "type": "string", "enum": ["move", "mark_read", "star"] },
                "folder": { "type": "string" },
                "dest_mailbox": { "type": "string", "description": "Optional other mailbox (id or email) for move; omit for this mailbox" },
                "enabled": { "type": "boolean" }
            }),
            &["mailbox", "rule_id", "name", "field", "value", "action"],
        ));
        tools.push(tool(
            "delete_rule",
            "Remove an inbox rule. Mail already filed stays where it is.",
            json!({ "mailbox": mailbox, "rule_id": { "type": "string" } }),
            &["mailbox", "rule_id"],
        ));
        tools.push(tool(
            "apply_rules",
            "Run the mailbox's rules over the newest messages already in a folder (default INBOX, up to 200).",
            json!({ "mailbox": mailbox, "folder": folder, "limit": { "type": "integer" } }),
            &["mailbox"],
        ));
        tools.push(tool(
            "create_folder",
            "Create a folder, for example one a rule will move mail into.",
            json!({ "mailbox": mailbox, "folder": { "type": "string" } }),
            &["mailbox", "folder"],
        ));
        tools.push(tool(
            "move_messages",
            "Move messages to another folder (for example Archive).",
            json!({
                "mailbox": mailbox, "folder": folder,
                "uids": { "type": "array", "items": { "type": "integer" } },
                "destination": { "type": "string" }
            }),
            &["mailbox", "folder", "uids", "destination"],
        ));
    }
    if permits(grant, Kind::Destructive).is_ok() {
        tools.push(tool(
            "delete_messages",
            "Permanently delete messages. This cannot be undone.",
            json!({
                "mailbox": mailbox, "folder": folder,
                "uids": { "type": "array", "items": { "type": "integer" } }
            }),
            &["mailbox", "folder", "uids"],
        ));
    }
    tools
}

fn text_result(value: &Value) -> Value {
    json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(value).unwrap_or_default() }] })
}

fn tool_error(msg: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": msg }] })
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing '{key}'"))
}

fn arg_uids(args: &Value) -> Result<Vec<u32>, String> {
    let list = args
        .get("uids")
        .and_then(Value::as_array)
        .ok_or("Missing 'uids'")?;
    let uids: Vec<u32> = list.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect();
    if uids.is_empty() || uids.len() != list.len() {
        return Err("'uids' must be a non-empty list of integers".into());
    }
    if uids.len() > 200 {
        return Err("At most 200 uids per call".into());
    }
    Ok(uids)
}

fn rule_args(args: &Value) -> Result<mail_rules::NewRule, String> {
    let get = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(mail_rules::NewRule {
        name: get("name").ok_or("Missing 'name'")?,
        field: get("field").ok_or("Missing 'field'")?,
        value: get("value").ok_or("Missing 'value'")?,
        action: get("action").ok_or("Missing 'action'")?,
        folder: get("folder"),
        dest_mailbox_id: None, // resolved against the grant in run_tool
    })
}

/// Resolve the optional `dest_mailbox` argument; it must be a mailbox this
/// passphrase is allowed to use.
async fn rule_args_checked(state: &AppState, grant: &Grant, args: &Value) -> Result<mail_rules::NewRule, String> {
    let mut r = rule_args(args)?;
    if let Some(d) = args.get("dest_mailbox").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty()) {
        r.dest_mailbox_id = Some(pick_mailbox(state, grant, d).await.map_err(|_| "This passphrase cannot use that dest_mailbox".to_string())?.id);
    }
    Ok(r)
}

fn arg_strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

async fn call_tool(state: &AppState, grant: &Grant, name: &str, args: &Value) -> Value {
    let kind = match name {
        "list_mailboxes" | "list_folders" | "list_messages" | "read_message" | "list_rules" => Kind::Read,
        "send_message" | "move_messages" | "create_folder" | "create_rule" | "update_rule" | "delete_rule"
        | "apply_rules" => Kind::Write,
        "set_flags" => flag_change_kind(&arg_strings(args, "flags"), args.get("add").and_then(Value::as_bool).unwrap_or(true)),
        "delete_messages" => Kind::Destructive,
        _ => return tool_error(&format!("Unknown tool '{name}'")),
    };
    let wanted = args.get("mailbox").and_then(Value::as_str).unwrap_or("").to_string();
    if let Err(msg) = permits(grant, kind) {
        record(state, grant, name, None, "denied", &msg).await;
        return tool_error(&msg);
    }
    if name == "list_mailboxes" {
        let mut out = Vec::new();
        for id in &grant.mailbox_ids {
            if let Ok(c) = mailboxes::creds_for(state, id).await {
                out.push(json!({ "id": c.id, "email": c.email }));
            }
        }
        record(state, grant, name, None, "ok", "").await;
        return text_result(&json!(out));
    }
    let creds = match pick_mailbox(state, grant, &wanted).await {
        Ok(c) => c,
        Err(msg) => {
            record(state, grant, name, None, "denied", &format!("mailbox '{}'", wanted.chars().take(80).collect::<String>())).await;
            return tool_error(&msg);
        }
    };
    match run_tool(state, grant, name, args, &creds).await {
        Ok((value, detail)) => {
            record(state, grant, name, Some(&creds.id), "ok", &detail).await;
            text_result(&value)
        }
        Err(msg) => {
            record(state, grant, name, Some(&creds.id), "error", &msg).await;
            tool_error(&msg)
        }
    }
}

/// Run one permitted tool against a mailbox. Returns the result and a short,
/// content-free note for the audit log.
async fn run_tool(
    state: &AppState,
    grant: &Grant,
    name: &str,
    args: &Value,
    creds: &mailboxes::MailboxCreds,
) -> Result<(Value, String), String> {
    let imap = creds.imap.clone();
    match name {
        "list_rules" => {
            let rules = mail_rules::list(state, &creds.id).await;
            let n = rules.len();
            Ok((json!(rules), format!("{n} rules")))
        }
        "create_rule" => {
            let r = mail_rules::create(state, &creds.id, &grant.id, &rule_args_checked(state, grant, args).await?).await?;
            Ok((json!(r), format!("{} {} -> {}", r.field, r.action, r.folder.as_deref().unwrap_or(""))))
        }
        "update_rule" => {
            let id = arg_str(args, "rule_id")?;
            let enabled = args.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            let r = mail_rules::update(state, &creds.id, &id, &rule_args_checked(state, grant, args).await?, enabled).await?;
            Ok((json!(r), format!("updated {id}")))
        }
        "delete_rule" => {
            let id = arg_str(args, "rule_id")?;
            mail_rules::delete(state, &creds.id, &id).await?;
            Ok((json!({ "ok": true }), format!("deleted {id}")))
        }
        "apply_rules" => {
            let folder = arg_str(args, "folder").unwrap_or_else(|_| "INBOX".to_string());
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
            let out = mail_rules::apply_now(state, creds, &folder, limit).await?;
            Ok((out.clone(), format!("{folder}: {out}")))
        }
        "create_folder" => {
            let folder = arg_str(args, "folder")?;
            if folder.chars().any(char::is_control) {
                return Err("Invalid folder name".into());
            }
            ops::imap_create_folder(imap, folder.clone(), Priority::Interactive).await?;
            Ok((json!({ "ok": true }), folder))
        }
        "list_folders" => {
            let folders = ops::imap_list_folders(imap, Priority::Interactive).await?;
            let out: Vec<Value> = folders
                .iter()
                .map(|f| json!({ "path": f.path, "special_use": f.special_use, "messages": f.exists, "unread": f.unseen }))
                .collect();
            Ok((json!(out), String::new()))
        }
        "list_messages" => {
            let folder = arg_str(args, "folder").unwrap_or_else(|_| "INBOX".to_string());
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, MAX_PAGE as u64) as usize;
            let before = args.get("before_uid").and_then(Value::as_u64).map(|v| v as u32);
            let mut uids = ops::imap_search_all_uids(imap.clone(), folder.clone(), Priority::Interactive).await?;
            uids.sort_unstable_by(|a, b| b.cmp(a));
            let page: Vec<u32> = uids.into_iter().filter(|u| before.map_or(true, |b| *u < b)).take(limit).collect();
            if page.is_empty() {
                return Ok((json!([]), format!("{folder}: 0")));
            }
            let fetched = ops::imap_fetch_messages(imap, folder.clone(), page.clone(), true, Priority::Interactive).await?;
            let mut messages = fetched.messages;
            messages.sort_unstable_by(|a, b| b.uid.cmp(&a.uid));
            let out: Vec<Value> = messages
                .iter()
                .map(|m| json!({
                    "uid": m.uid, "from": m.from_address, "from_name": m.from_name, "to": m.to_addresses,
                    "subject": m.subject, "date": m.date, "unread": !m.is_read, "starred": m.is_starred,
                    "message_id": m.message_id, "attachments_hint": m.has_attachments_hint,
                }))
                .collect();
            Ok((json!(out), format!("{folder}: {}", out.len())))
        }
        "read_message" => {
            let folder = arg_str(args, "folder")?;
            let uid = args.get("uid").and_then(Value::as_u64).ok_or("Missing 'uid'")? as u32;
            let m = ops::imap_fetch_message_body(imap, folder.clone(), uid, Priority::Interactive).await?;
            let mut text = m.body_text.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
                strip_tags(m.body_html.as_deref().unwrap_or(m.snippet.as_deref().unwrap_or("")))
            });
            let truncated = text.chars().count() > MAX_BODY_CHARS;
            if truncated {
                text = text.chars().take(MAX_BODY_CHARS).collect();
            }
            let attachments: Vec<Value> = m
                .attachments
                .iter()
                .filter(|a| !a.is_inline)
                .map(|a| json!({ "filename": a.filename, "mime_type": a.mime_type, "size": a.size }))
                .collect();
            Ok((
                json!({
                    "uid": m.uid, "message_id": m.message_id, "in_reply_to": m.in_reply_to,
                    "from": m.from_address, "from_name": m.from_name, "to": m.to_addresses, "cc": m.cc_addresses,
                    "subject": m.subject, "date": m.date, "body": text, "body_truncated": truncated,
                    "attachments": attachments,
                }),
                format!("{folder} uid {uid}"),
            ))
        }
        "send_message" => {
            let to = arg_strings(args, "to");
            let cc = arg_strings(args, "cc");
            let subject = arg_str(args, "subject")?;
            let body = args.get("body").and_then(Value::as_str).ok_or("Missing 'body'")?;
            if to.is_empty() {
                return Err("At least one recipient in 'to'".into());
            }
            if to.len() + cc.len() > 50 {
                return Err("At most 50 recipients".into());
            }
            let reply_to = args.get("in_reply_to").and_then(Value::as_str).map(str::to_string);
            let raw = build_raw_email(&creds.email, &to, &cc, &subject, body, reply_to.as_deref())?;
            let result = ops::smtp_send_email(creds.smtp.clone(), raw).await?;
            Ok((json!({ "sent": result.success, "message": result.message }), format!("to {} ({} recipients)", to[0], to.len() + cc.len())))
        }
        "set_flags" => {
            let folder = arg_str(args, "folder")?;
            let uids = arg_uids(args)?;
            let flags = arg_strings(args, "flags");
            if flags.is_empty() {
                return Err("Missing 'flags'".into());
            }
            let add = args.get("add").and_then(Value::as_bool).ok_or("Missing 'add'")?;
            let n = uids.len();
            ops::imap_set_flags(imap, folder.clone(), uids, flags.clone(), add, Priority::Interactive).await?;
            Ok((json!({ "ok": true }), format!("{folder}: {} {} on {n}", if add { "+" } else { "-" }, flags.join(" "))))
        }
        "move_messages" => {
            let folder = arg_str(args, "folder")?;
            let destination = arg_str(args, "destination")?;
            let uids = arg_uids(args)?;
            let n = uids.len();
            ops::imap_move_messages(imap, folder.clone(), uids, destination.clone(), Priority::Interactive).await?;
            Ok((json!({ "ok": true }), format!("{folder} -> {destination}: {n}")))
        }
        "delete_messages" => {
            let folder = arg_str(args, "folder")?;
            let uids = arg_uids(args)?;
            let n = uids.len();
            ops::imap_delete_messages(imap, folder.clone(), uids, Priority::Interactive).await?;
            Ok((json!({ "ok": true }), format!("{folder}: {n}")))
        }
        _ => Err(format!("Unknown tool '{name}'")),
    }
}

// ---------- message helpers ----------

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn header_safe(value: &str) -> Result<&str, String> {
    if value.contains('\r') || value.contains('\n') {
        Err("Header values cannot contain line breaks".into())
    } else {
        Ok(value)
    }
}

/// Build the base64url-encoded RFC 5322 message `smtp_send_email` expects.
fn build_raw_email(
    from: &str,
    to: &[String],
    cc: &[String],
    subject: &str,
    body: &str,
    in_reply_to: Option<&str>,
) -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut head = String::new();
    head.push_str(&format!("From: {}\r\n", header_safe(from)?));
    head.push_str(&format!("To: {}\r\n", header_safe(&to.join(", "))?));
    if !cc.is_empty() {
        head.push_str(&format!("Cc: {}\r\n", header_safe(&cc.join(", "))?));
    }
    let subject = header_safe(subject)?;
    if subject.is_ascii() {
        head.push_str(&format!("Subject: {subject}\r\n"));
    } else {
        head.push_str(&format!("Subject: =?UTF-8?B?{}?=\r\n", b64.encode(subject)));
    }
    if let Some(id) = in_reply_to {
        let id = header_safe(id)?;
        head.push_str(&format!("In-Reply-To: {id}\r\nReferences: {id}\r\n"));
    }
    head.push_str(&format!("Message-ID: <{}@velo-mcp>\r\n", new_id()));
    head.push_str("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    let encoded = b64.encode(body);
    let wrapped: Vec<&str> = encoded.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap_or("")).collect();
    head.push_str(&wrapped.join("\r\n"));
    head.push_str("\r\n");
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(head))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(scope: &str, block: bool) -> Grant {
        Grant { id: "g".into(), scope: scope.into(), block_destructive: block, mailbox_ids: vec![] }
    }

    #[test]
    fn read_only_allows_only_reading() {
        let g = grant(SCOPE_READ, true);
        assert!(permits(&g, Kind::Read).is_ok());
        assert!(permits(&g, Kind::Write).is_err());
        assert!(permits(&g, Kind::Destructive).is_err());
    }

    #[test]
    fn read_send_blocks_delete_while_destructive_is_blocked() {
        let g = grant(SCOPE_READ_SEND, true);
        assert!(permits(&g, Kind::Write).is_ok());
        assert!(permits(&g, Kind::Destructive).is_err());
    }

    #[test]
    fn read_send_can_delete_once_unblocked() {
        let g = grant(SCOPE_READ_SEND, false);
        assert!(permits(&g, Kind::Destructive).is_ok());
    }

    #[test]
    fn only_adding_deleted_counts_as_destructive() {
        let del = vec!["\\Deleted".to_string()];
        let seen = vec!["\\Seen".to_string()];
        assert_eq!(flag_change_kind(&del, true), Kind::Destructive);
        assert_eq!(flag_change_kind(&del, false), Kind::Write);
        assert_eq!(flag_change_kind(&seen, true), Kind::Write);
        assert_eq!(flag_change_kind(&["deleted".to_string()], true), Kind::Destructive);
    }

    #[test]
    fn tool_list_hides_what_the_grant_cannot_do() {
        let names = |g: &Grant| -> Vec<String> {
            tool_list(g).iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
        };
        let read = names(&grant(SCOPE_READ, false));
        assert!(!read.contains(&"send_message".to_string()));
        assert!(!read.contains(&"delete_messages".to_string()));
        let blocked = names(&grant(SCOPE_READ_SEND, true));
        assert!(blocked.contains(&"send_message".to_string()));
        assert!(!blocked.contains(&"delete_messages".to_string()));
        let open = names(&grant(SCOPE_READ_SEND, false));
        assert!(open.contains(&"delete_messages".to_string()));
    }

    #[test]
    fn passphrases_hash_stably_and_are_long() {
        let p = new_passphrase();
        assert!(p.starts_with("vpk_") && p.len() == 4 + 64);
        assert_eq!(hash_secret(&p), hash_secret(&p));
        assert_ne!(hash_secret(&p), hash_secret(&new_passphrase()));
    }

    #[test]
    fn raw_email_rejects_header_injection() {
        let r = build_raw_email("a@x.com", &["b@x.com".into()], &[], "hi\r\nBcc: evil@x.com", "body", None);
        assert!(r.is_err());
        let ok = build_raw_email("a@x.com", &["b@x.com".into()], &[], "Grüße", "body", None).unwrap();
        let raw = String::from_utf8(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(ok).unwrap()).unwrap();
        assert!(raw.contains("Subject: =?UTF-8?B?"));
        assert!(raw.contains("From: a@x.com"));
    }
}
