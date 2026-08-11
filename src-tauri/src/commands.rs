//! Tauri command wrappers. The actual IMAP/SMTP logic lives in `velo-core`
//! (`velo_core::ops`), shared with the web server. These are thin adapters that
//! expose the core ops to the desktop frontend over Tauri IPC.

use velo_core::ops;
use velo_core::{
    DeltaCheckRequest, DeltaCheckResult, ImapConfig, ImapFetchResult, ImapFolder,
    ImapFolderSearchResult, ImapFolderStatus, ImapFolderSyncResult, ImapMessage, SmtpConfig,
    SmtpSendResult,
};

// ---------- IMAP commands ----------

#[tauri::command]
pub async fn imap_test_connection(config: ImapConfig) -> Result<String, String> {
    ops::imap_test_connection(config).await
}

#[tauri::command]
pub async fn imap_list_folders(config: ImapConfig) -> Result<Vec<ImapFolder>, String> {
    ops::imap_list_folders(config).await
}

#[tauri::command]
pub async fn imap_fetch_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<ImapFetchResult, String> {
    ops::imap_fetch_messages(config, folder, uids).await
}

#[tauri::command]
pub async fn imap_fetch_new_uids(
    config: ImapConfig,
    folder: String,
    since_uid: u32,
) -> Result<Vec<u32>, String> {
    ops::imap_fetch_new_uids(config, folder, since_uid).await
}

#[tauri::command]
pub async fn imap_search_all_uids(config: ImapConfig, folder: String) -> Result<Vec<u32>, String> {
    ops::imap_search_all_uids(config, folder).await
}

#[tauri::command]
pub async fn imap_fetch_message_body(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<ImapMessage, String> {
    ops::imap_fetch_message_body(config, folder, uid).await
}

#[tauri::command]
pub async fn imap_fetch_raw_message(
    config: ImapConfig,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    ops::imap_fetch_raw_message(config, folder, uid).await
}

#[tauri::command]
pub async fn imap_set_flags(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    flags: Vec<String>,
    add: bool,
) -> Result<(), String> {
    ops::imap_set_flags(config, folder, uids, flags, add).await
}

#[tauri::command]
pub async fn imap_move_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<(), String> {
    ops::imap_move_messages(config, folder, uids, destination).await
}

#[tauri::command]
pub async fn imap_delete_messages(
    config: ImapConfig,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), String> {
    ops::imap_delete_messages(config, folder, uids).await
}

#[tauri::command]
pub async fn imap_get_folder_status(
    config: ImapConfig,
    folder: String,
) -> Result<ImapFolderStatus, String> {
    ops::imap_get_folder_status(config, folder).await
}

#[tauri::command]
pub async fn imap_fetch_attachment(
    config: ImapConfig,
    folder: String,
    uid: u32,
    part_id: String,
) -> Result<String, String> {
    ops::imap_fetch_attachment(config, folder, uid, part_id).await
}

#[tauri::command]
pub async fn imap_append_message(
    config: ImapConfig,
    folder: String,
    flags: Option<String>,
    raw_message: String,
) -> Result<(), String> {
    ops::imap_append_message(config, folder, flags, raw_message).await
}

#[tauri::command]
pub async fn imap_search_message_id(
    config: ImapConfig,
    folder: String,
    message_id: String,
) -> Result<Option<u32>, String> {
    ops::imap_search_message_id(config, folder, message_id).await
}

#[tauri::command]
pub async fn imap_search_folder(
    config: ImapConfig,
    folder: String,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    ops::imap_search_folder(config, folder, since_date).await
}

#[tauri::command]
pub async fn imap_sync_folder(
    config: ImapConfig,
    folder: String,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    ops::imap_sync_folder(config, folder, batch_size, since_date).await
}

#[tauri::command]
pub async fn imap_raw_fetch_diagnostic(
    config: ImapConfig,
    folder: String,
    uid_range: String,
) -> Result<String, String> {
    ops::imap_raw_fetch_diagnostic(config, folder, uid_range).await
}

#[tauri::command]
pub async fn imap_delta_check(
    config: ImapConfig,
    folders: Vec<DeltaCheckRequest>,
) -> Result<Vec<DeltaCheckResult>, String> {
    ops::imap_delta_check(config, folders).await
}

// ---------- SMTP commands ----------

#[tauri::command]
pub async fn smtp_send_email(
    config: SmtpConfig,
    raw_email: String,
) -> Result<SmtpSendResult, String> {
    ops::smtp_send_email(config, raw_email).await
}

#[tauri::command]
pub async fn smtp_test_connection(config: SmtpConfig) -> Result<SmtpSendResult, String> {
    ops::smtp_test_connection(config).await
}
