//! HTTP handlers mirroring the desktop Tauri IMAP/SMTP commands.
//!
//! **Credential model (web security):** the browser sends a `mailboxId` instead
//! of real credentials. The server resolves the IMAP/SMTP config from the
//! control DB (decrypting the password with the server key) and enforces that
//! the caller owns the mailbox. A raw `config` is still accepted as a fallback
//! (used by tests and for parity with the desktop command shape), but the web
//! frontend always sends `mailboxId` so secrets never leave the server.

use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Extension, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use velo_core::imap::scheduler::Priority;
use velo_core::ops;
use velo_core::{DeltaCheckRequest, ImapConfig, SmtpConfig};

use crate::mailboxes;
use crate::state::{AppState, User};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/imap/test_connection", post(imap_test_connection))
        .route("/imap/list_folders", post(imap_list_folders))
        .route("/imap/fetch_messages", post(imap_fetch_messages))
        .route("/imap/fetch_new_uids", post(imap_fetch_new_uids))
        .route("/imap/search_all_uids", post(imap_search_all_uids))
        .route("/imap/fetch_message_body", post(imap_fetch_message_body))
        .route("/imap/fetch_raw_message", post(imap_fetch_raw_message))
        .route("/imap/set_flags", post(imap_set_flags))
        .route("/imap/move_messages", post(imap_move_messages))
        .route("/imap/delete_messages", post(imap_delete_messages))
        .route("/imap/get_folder_status", post(imap_get_folder_status))
        .route("/imap/fetch_attachment", post(imap_fetch_attachment))
        .route("/imap/append_message", post(imap_append_message))
        .route("/imap/search_folder", post(imap_search_folder))
        .route("/imap/sync_folder", post(imap_sync_folder))
        .route("/imap/raw_fetch_diagnostic", post(imap_raw_fetch_diagnostic))
        .route("/imap/delta_check", post(imap_delta_check))
        .route("/smtp/send", post(smtp_send_email))
        .route("/smtp/test_connection", post(smtp_test_connection))
        .with_state(state)
}

fn ok<T: Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(msg) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response(),
    }
}

fn bad(msg: String) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
}

fn priority_of(label: &Option<String>) -> Priority {
    Priority::from_label(label.as_deref())
}


/// Pick the IMAP config to use: resolve from `mailboxId` (server-side, ownership
/// enforced) when present, else fall back to a directly-supplied `config`.
async fn imap_cfg(
    state: &AppState,
    user: &User,
    mailbox_id: &Option<String>,
    config: Option<ImapConfig>,
) -> Result<ImapConfig, String> {
    match mailbox_id {
        Some(id) => mailboxes::resolve_imap(state, user, id).await,
        None => config.ok_or_else(|| "Missing mailboxId or config".to_string()),
    }
}

async fn smtp_cfg(
    state: &AppState,
    user: &User,
    mailbox_id: &Option<String>,
    config: Option<SmtpConfig>,
) -> Result<SmtpConfig, String> {
    match mailbox_id {
        Some(id) => mailboxes::resolve_smtp(state, user, id).await,
        None => config.ok_or_else(|| "Missing mailboxId or config".to_string()),
    }
}

// ---------- request bodies ----------
// Every IMAP body carries an optional `mailboxId` (preferred) and optional
// `config` (fallback). camelCase to match the frontend.

#[derive(Deserialize)]
struct ConfigOnly {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
}

#[derive(Deserialize)]
struct FolderReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
}

#[derive(Deserialize)]
struct FetchMessagesReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uids: Vec<u32>,
    #[serde(rename = "headersOnly", default)]
    headers_only: Option<bool>,
}

#[derive(Deserialize)]
struct NewUidsReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    #[serde(rename = "sinceUid")]
    since_uid: u32,
}

#[derive(Deserialize)]
struct MessageBodyReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uid: u32,
}

#[derive(Deserialize)]
struct SetFlagsReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
}

#[derive(Deserialize)]
struct MoveReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uids: Vec<u32>,
    destination: String,
}

#[derive(Deserialize)]
struct DeleteReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uids: Vec<u32>,
}

#[derive(Deserialize)]
struct AttachmentReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    uid: u32,
    #[serde(rename = "partId")]
    part_id: String,
}

#[derive(Deserialize)]
struct AppendReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    flags: Option<String>,
    #[serde(rename = "rawMessage")]
    raw_message: String,
}

#[derive(Deserialize)]
struct SearchFolderReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    #[serde(rename = "sinceDate")]
    since_date: Option<String>,
}

#[derive(Deserialize)]
struct SyncFolderReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folder: String,
    #[serde(rename = "batchSize")]
    batch_size: u32,
    #[serde(rename = "sinceDate")]
    since_date: Option<String>,
}

#[derive(Deserialize)]
struct RawDiagnosticReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    folder: String,
    #[serde(rename = "uidRange")]
    uid_range: String,
}

#[derive(Deserialize)]
struct DeltaCheckReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<ImapConfig>,
    #[serde(default)]
    priority: Option<String>,
    folders: Vec<DeltaCheckRequest>,
}

#[derive(Deserialize)]
struct SmtpSendReq {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<SmtpConfig>,
    #[serde(rename = "rawEmail")]
    raw_email: String,
}

#[derive(Deserialize)]
struct SmtpConfigOnly {
    #[serde(rename = "mailboxId", default)]
    mailbox_id: Option<String>,
    config: Option<SmtpConfig>,
}

// ---------- IMAP handlers ----------

async fn imap_test_connection(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<ConfigOnly>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_test_connection(c).await),
        Err(e) => bad(e),
    }
}

async fn imap_list_folders(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<ConfigOnly>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_list_folders(c, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_fetch_messages(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<FetchMessagesReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_fetch_messages(c, req.folder, req.uids, req.headers_only.unwrap_or(false), priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_fetch_new_uids(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<NewUidsReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_fetch_new_uids(c, req.folder, req.since_uid, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_search_all_uids(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<FolderReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_search_all_uids(c, req.folder, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_fetch_message_body(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<MessageBodyReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_fetch_message_body(c, req.folder, req.uid, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_fetch_raw_message(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<MessageBodyReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_fetch_raw_message(c, req.folder, req.uid, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_set_flags(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<SetFlagsReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_set_flags(c, req.folder, req.uids, req.flags, req.add, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_move_messages(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<MoveReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_move_messages(c, req.folder, req.uids, req.destination, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_delete_messages(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<DeleteReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_delete_messages(c, req.folder, req.uids, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_get_folder_status(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<FolderReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_get_folder_status(c, req.folder, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_fetch_attachment(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<AttachmentReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_fetch_attachment(c, req.folder, req.uid, req.part_id, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_append_message(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<AppendReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_append_message(c, req.folder, req.flags, req.raw_message, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_search_folder(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<SearchFolderReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_search_folder(c, req.folder, req.since_date, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_sync_folder(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<SyncFolderReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_sync_folder(c, req.folder, req.batch_size, req.since_date, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

async fn imap_raw_fetch_diagnostic(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<RawDiagnosticReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_raw_fetch_diagnostic(c, req.folder, req.uid_range).await),
        Err(e) => bad(e),
    }
}

async fn imap_delta_check(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<DeltaCheckReq>,
) -> Response {
    match imap_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::imap_delta_check(c, req.folders, priority_of(&req.priority)).await),
        Err(e) => bad(e),
    }
}

// ---------- SMTP handlers ----------

async fn smtp_send_email(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<SmtpSendReq>,
) -> Response {
    match smtp_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::smtp_send_email(c, req.raw_email).await),
        Err(e) => bad(e),
    }
}

async fn smtp_test_connection(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
    Json(req): Json<SmtpConfigOnly>,
) -> Response {
    match smtp_cfg(&state, &user, &req.mailbox_id, req.config).await {
        Ok(c) => ok(ops::smtp_test_connection(c).await),
        Err(e) => bad(e),
    }
}
