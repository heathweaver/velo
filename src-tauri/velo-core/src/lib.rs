//! velo-core — shared IMAP/SMTP/OAuth protocol logic for Velo.
//!
//! This crate contains zero Tauri or HTTP-transport code. Both the desktop
//! Tauri commands (`src-tauri`) and the web server (`velo-server`) depend on it
//! and expose its `ops` / `oauth` functions over their respective transports.

pub mod imap;
pub mod oauth;
pub mod ops;
pub mod smtp;
pub mod store;

// Re-export the config/result types most commonly needed by callers.
pub use imap::types::{
    DeltaCheckRequest, DeltaCheckResult, ImapAttachment, ImapConfig, ImapFetchResult, ImapFolder,
    ImapFolderSearchResult, ImapFolderStatus, ImapFolderSyncResult, ImapMessage,
};
pub use oauth::{OAuthResult, TokenExchangeResult};
pub use smtp::types::{SmtpConfig, SmtpSendResult};
