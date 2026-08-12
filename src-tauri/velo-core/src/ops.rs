//! IMAP/SMTP orchestration operations, shared by the Tauri desktop commands
//! and the web server. These wrap the lower-level `imap::client` / `smtp::client`
//! functions with connect → operate → logout flows. They contain no Tauri or
//! transport-specific code, so both the desktop `#[tauri::command]` wrappers and
//! the Axum handlers call straight into these.

use std::sync::OnceLock;

use crate::imap::client as imap_client;
use crate::imap::pool::SessionPool;
use crate::imap::scheduler::{Priority, Scheduler, Turn};
use crate::imap::types::{
    DeltaCheckRequest, DeltaCheckResult, ImapConfig, ImapFetchResult, ImapFolder,
    ImapFolderSearchResult, ImapFolderStatus, ImapFolderSyncResult, ImapMessage,
};
use crate::smtp::client as smtp_client;
use crate::smtp::types::{SmtpConfig, SmtpSendResult};

/// Process-wide pool of authenticated IMAP sessions.
///
/// Global rather than threaded through every caller, so routing these
/// operations through it changes nothing above this layer: the Tauri commands
/// and the web handlers keep their signatures, and the TypeScript side is
/// untouched. Sessions are keyed per account inside the pool.
static SESSION_POOL: OnceLock<SessionPool> = OnceLock::new();

fn pool() -> &'static SessionPool {
    SESSION_POOL.get_or_init(SessionPool::new)
}

static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();

fn scheduler() -> &'static Scheduler {
    SCHEDULER.get_or_init(Scheduler::new)
}

/// Identifies the account for scheduling — the same identity the pool keys on.
fn account_of(config: &ImapConfig) -> String {
    format!("{}:{}/{}", config.host, config.port, config.username)
}

/// Wait for this account's turn, then take a session.
///
/// The returned Turn must stay alive for the whole operation: it is what stops
/// two callers using one account's connection at once, and it is released when
/// dropped, including on the `?` paths below.
async fn checkout(
    config: &ImapConfig,
    priority: Priority,
) -> Result<(imap_client::ImapSession, Turn), String> {
    let turn = scheduler().acquire(&account_of(config), priority).await;
    let session = pool().check_out(config).await?;
    Ok((session, turn))
}

/// Give the session back after a successful operation.
///
/// Replaces the `session.logout()` these functions used to end with. On the
/// error paths the session is simply dropped, which closes the socket — the
/// same thing that happened before, since `?` skipped the logout too.
async fn checkin(config: &ImapConfig, session: imap_client::ImapSession, turn: Turn) {
    pool().check_in(config, session).await;
    turn.release();
}

/// Drop every pooled session. Used when credentials change or an account is
/// removed, so the pool cannot keep talking to a server the user disconnected.
pub async fn imap_evict_sessions() {
    pool().evict_all().await;
}

// ---------- IMAP ops ----------

pub async fn imap_test_connection(config: ImapConfig) -> Result<String, String> {
    imap_client::test_connection(&config).await
}

pub async fn imap_list_folders(config: ImapConfig, priority: Priority) -> Result<Vec<ImapFolder>, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let folders = imap_client::list_folders(&mut session).await?;
    checkin(&config, session, turn).await;
    Ok(folders)
}

pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    priority: Priority,
) -> Result<ImapFetchResult, String> {
    if uids.is_empty() {
        return Err("No UIDs provided".to_string());
    }

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let (mut session, turn) = checkout(&config, priority).await?;
    let result = imap_client::fetch_messages(&mut session, &folder, &uid_set).await;
    checkin(&config, session, turn).await;

    match result {
        Ok(r) => Ok(r),
        Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
            log::info!("Falling back to raw TCP fetch for folder {folder}");
            imap_client::raw_fetch_messages(&config, &folder, &uid_set).await
        }
        Err(e) => Err(e),
    }
}

pub async fn imap_fetch_new_uids(
    config: ImapConfig,
    folder: String,
    since_uid: u32,
    priority: Priority,
) -> Result<Vec<u32>, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let uids = imap_client::fetch_new_uids(&mut session, &folder, since_uid).await?;
    checkin(&config, session, turn).await;
    Ok(uids)
}

pub async fn imap_search_all_uids(
    config: ImapConfig,
    folder: String,
    priority: Priority,
) -> Result<Vec<u32>, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let uids = imap_client::search_all_uids(&mut session, &folder).await?;
    checkin(&config, session, turn).await;
    Ok(uids)
}

pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
    priority: Priority,
) -> Result<ImapMessage, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let message = imap_client::fetch_message_body(&mut session, &folder, uid).await?;
    checkin(&config, session, turn).await;
    Ok(message)
}

pub async fn imap_fetch_raw_message(
    config: ImapConfig,
    folder: String,
    uid: u32,
    priority: Priority,
) -> Result<String, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let raw = imap_client::fetch_raw_message(&mut session, &folder, uid).await?;
    checkin(&config, session, turn).await;
    Ok(raw)
}

pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
    priority: Priority,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let (mut session, turn) = checkout(&config, priority).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let flag_op = if add { "+FLAGS" } else { "-FLAGS" };

    let flags_str = format!(
        "({})",
        flags
            .iter()
            .map(|f| {
                if f.starts_with('\\') {
                    f.clone()
                } else {
                    format!("\\{f}")
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );

    imap_client::set_flags(&mut session, &folder, &uid_set, flag_op, &flags_str).await?;
    checkin(&config, session, turn).await;
    Ok(())
}

pub async fn imap_move_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
    priority: Priority,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let (mut session, turn) = checkout(&config, priority).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::move_messages(&mut session, &folder, &uid_set, &destination).await?;
    checkin(&config, session, turn).await;
    Ok(())
}

pub async fn imap_delete_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    priority: Priority,
) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }

    let (mut session, turn) = checkout(&config, priority).await?;

    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    imap_client::delete_messages(&mut session, &folder, &uid_set).await?;
    checkin(&config, session, turn).await;
    Ok(())
}

pub async fn imap_get_folder_status(
    config: ImapConfig,
    folder: String,
    priority: Priority,
) -> Result<ImapFolderStatus, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let status = imap_client::get_folder_status(&mut session, &folder).await?;
    checkin(&config, session, turn).await;
    Ok(status)
}

pub async fn imap_fetch_attachment(
    config: ImapConfig,
    folder: String,
    uid: u32,
    part_id: String,
    priority: Priority,
) -> Result<String, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let data = imap_client::fetch_attachment(&mut session, &folder, uid, &part_id).await?;
    checkin(&config, session, turn).await;
    Ok(data)
}

/// Resolve a message's UID from its Message-ID header.
///
/// Used after APPEND so a draft can be addressed — and therefore deleted —
/// later, without depending on server UIDPLUS support.
pub async fn imap_search_message_id(
    config: ImapConfig,
    folder: String,
    message_id: String,
    priority: Priority,
) -> Result<Option<u32>, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let uid = imap_client::search_by_message_id(&mut session, &folder, &message_id).await?;
    checkin(&config, session, turn).await;
    Ok(uid)
}

pub async fn imap_append_message(
    config: ImapConfig,
    folder: String,
    flags: Option<String>,
    raw_message: String,
    priority: Priority,
) -> Result<(), String> {
    let (mut session, turn) = checkout(&config, priority).await?;

    // raw_message is base64url-encoded; decode it
    let raw_bytes = base64url_decode(&raw_message)?;

    let flags_ref = flags.as_deref();
    imap_client::append_message(&mut session, &folder, flags_ref, &raw_bytes).await?;
    checkin(&config, session, turn).await;
    Ok(())
}

fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    engine
        .decode(input)
        .map_err(|e| format!("base64url decode failed: {e}"))
}

pub async fn imap_search_folder(
    config: ImapConfig,
    folder: String,
    since_date: Option<String>,
    priority: Priority,
) -> Result<ImapFolderSearchResult, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let result = imap_client::search_folder(&mut session, &folder, since_date).await;
    checkin(&config, session, turn).await;
    result
}

pub async fn imap_sync_folder(
    config: ImapConfig,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
    priority: Priority,
) -> Result<ImapFolderSyncResult, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let result = imap_client::sync_folder(&mut session, &folder, batch_size, since_date).await;
    checkin(&config, session, turn).await;
    result
}

pub async fn imap_raw_fetch_diagnostic(
    config: ImapConfig,
    folder: String,
    uid_range: String,
) -> Result<String, String> {
    imap_client::raw_fetch_diagnostic(&config, &folder, &uid_range).await
}

pub async fn imap_delta_check(
    config: ImapConfig,
    folders: Vec<DeltaCheckRequest>,
    priority: Priority,
) -> Result<Vec<DeltaCheckResult>, String> {
    let (mut session, turn) = checkout(&config, priority).await?;
    let results = imap_client::delta_check_folders(&mut session, &folders).await?;
    checkin(&config, session, turn).await;
    Ok(results)
}

// ---------- SMTP ops ----------

pub async fn smtp_send_email(
    config: SmtpConfig,
    raw_email: String,
) -> Result<SmtpSendResult, String> {
    smtp_client::send_raw_email(&config, &raw_email).await
}

pub async fn smtp_test_connection(config: SmtpConfig) -> Result<SmtpSendResult, String> {
    smtp_client::test_connection(&config).await
}
