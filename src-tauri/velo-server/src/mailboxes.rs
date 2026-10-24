//! Provisioned IMAP/SMTP mailbox management + server-side credential resolution.
//!
//! - Admin endpoints (`/api/admin/mailboxes`) create/list/delete mailboxes and
//!   assign each to an owner user.
//! - Members get `/api/mailboxes` — their own mailboxes WITHOUT the password, so
//!   the app can show/use them but a member can never read or edit credentials.
//! - `resolve_imap` / `resolve_smtp` turn a mailbox id (sent by the browser in
//!   place of a full config) into a real config with the decrypted password,
//!   enforcing that the caller owns the mailbox (admin may use any).

use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use velo_core::{ImapConfig, SmtpConfig};

use crate::server_crypto;
use crate::state::{new_id, AppState, User};

pub fn admin_router(state: AppState) -> Router {
    Router::new()
        .route("/mailboxes", get(list_all).post(create))
        .route("/mailboxes/:id", axum::routing::delete(delete_mailbox))
        .with_state(state)
}

pub fn member_router(state: AppState) -> Router {
    Router::new()
        .route("/mailboxes", get(list_mine))
        .with_state(state)
}

#[derive(sqlx::FromRow)]
struct MailboxRow {
    id: String,
    owner_user_id: String,
    email: String,
    display_name: Option<String>,
    imap_host: String,
    imap_port: i64,
    imap_security: String,
    smtp_host: String,
    smtp_port: i64,
    smtp_security: String,
    username: Option<String>,
    password_enc: String,
    accept_invalid_certs: i64,
}

impl MailboxRow {
    /// IMAP/SMTP login username. Falls back to the mailbox email when no
    /// username is set — treating an empty/whitespace string as "not set"
    /// (the admin form submits "" when the field is left blank).
    fn login_username(&self) -> String {
        match self.username.as_deref().map(str::trim) {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => self.email.clone(),
        }
    }
}

/// Public (non-secret) view of a mailbox — never includes the password.
#[derive(Serialize)]
struct MailboxView {
    id: String,
    #[serde(rename = "ownerUserId")]
    owner_user_id: String,
    email: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "imapHost")]
    imap_host: String,
    #[serde(rename = "imapPort")]
    imap_port: i64,
    #[serde(rename = "imapSecurity")]
    imap_security: String,
    #[serde(rename = "smtpHost")]
    smtp_host: String,
    #[serde(rename = "smtpPort")]
    smtp_port: i64,
    #[serde(rename = "smtpSecurity")]
    smtp_security: String,
    username: Option<String>,
    #[serde(rename = "acceptInvalidCerts")]
    accept_invalid_certs: bool,
}

impl From<&MailboxRow> for MailboxView {
    fn from(m: &MailboxRow) -> Self {
        MailboxView {
            id: m.id.clone(),
            owner_user_id: m.owner_user_id.clone(),
            email: m.email.clone(),
            display_name: m.display_name.clone(),
            imap_host: m.imap_host.clone(),
            imap_port: m.imap_port,
            imap_security: m.imap_security.clone(),
            smtp_host: m.smtp_host.clone(),
            smtp_port: m.smtp_port,
            smtp_security: m.smtp_security.clone(),
            username: m.username.clone(),
            accept_invalid_certs: m.accept_invalid_certs != 0,
        }
    }
}

async fn fetch_mailbox(state: &AppState, id: &str) -> Option<MailboxRow> {
    let mut control = state.control.lock().await;
    sqlx::query_as::<_, MailboxRow>("SELECT * FROM mailboxes WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *control)
        .await
        .ok()
        .flatten()
}

/// Server-internal: one mailbox's owner + email + resolved IMAP config. Used by
/// the notification worker (no user context — runs as the server).
pub struct MailboxCreds {
    pub id: String,
    pub owner_user_id: String,
    pub email: String,
    pub imap: ImapConfig,
    pub smtp: SmtpConfig,
}

fn row_to_creds(m: MailboxRow) -> Result<MailboxCreds, String> {
    let password = server_crypto::decrypt(&m.password_enc)?;
    let username = m.login_username();
    Ok(MailboxCreds {
        id: m.id.clone(),
        owner_user_id: m.owner_user_id.clone(),
        email: m.email.clone(),
        imap: ImapConfig {
            host: m.imap_host.clone(),
            port: m.imap_port as u16,
            security: m.imap_security.clone(),
            username: username.clone(),
            password: password.clone(),
            auth_method: "password".to_string(),
            accept_invalid_certs: m.accept_invalid_certs != 0,
        },
        smtp: SmtpConfig {
            host: m.smtp_host,
            port: m.smtp_port as u16,
            security: m.smtp_security,
            username,
            password,
            auth_method: "password".to_string(),
            accept_invalid_certs: m.accept_invalid_certs != 0,
        },
    })
}

/// One mailbox's resolved credentials by id, with no user check. Only for
/// callers that have already authorised the mailbox some other way (the agent
/// access grant lists the mailboxes it may use).
pub async fn creds_for(state: &AppState, id: &str) -> Result<MailboxCreds, String> {
    let m = fetch_mailbox(state, id)
        .await
        .ok_or_else(|| "Mailbox not found".to_string())?;
    row_to_creds(m)
}

/// Whether a mailbox id exists (for validating an agent grant).
pub async fn exists(state: &AppState, id: &str) -> bool {
    fetch_mailbox(state, id).await.is_some()
}

/// All provisioned mailboxes with resolved credentials (server-internal).
pub async fn all_with_creds(state: &AppState) -> Vec<MailboxCreds> {
    let mut control = state.control.lock().await;
    let rows = sqlx::query_as::<_, MailboxRow>("SELECT * FROM mailboxes")
        .fetch_all(&mut *control)
        .await
        .unwrap_or_default();
    drop(control);
    rows.into_iter().filter_map(|r| row_to_creds(r).ok()).collect()
}

/// The mailbox used to SEND notification emails: the first mailbox owned by an
/// admin user. None if no admin has a provisioned mailbox.
pub async fn admin_sender(state: &AppState) -> Option<MailboxCreds> {
    let mut control = state.control.lock().await;
    let row = sqlx::query_as::<_, MailboxRow>(
        "SELECT m.* FROM mailboxes m JOIN users u ON u.id = m.owner_user_id \
         WHERE u.role = 'admin' ORDER BY m.created_at LIMIT 1",
    )
    .fetch_optional(&mut *control)
    .await
    .ok()
    .flatten()?;
    drop(control);
    row_to_creds(row).ok()
}

// ---------- admin endpoints ----------

async fn list_all(State(state): State<AppState>) -> Response {
    let mut control = state.control.lock().await;
    let rows = sqlx::query_as::<_, MailboxRow>("SELECT * FROM mailboxes ORDER BY email")
        .fetch_all(&mut *control)
        .await
        .unwrap_or_default();
    let views: Vec<MailboxView> = rows.iter().map(MailboxView::from).collect();
    Json(views).into_response()
}

#[derive(Deserialize)]
struct CreateMailbox {
    #[serde(rename = "ownerUserId")]
    owner_user_id: String,
    email: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "imapHost")]
    imap_host: String,
    #[serde(rename = "imapPort")]
    imap_port: i64,
    #[serde(rename = "imapSecurity")]
    imap_security: String,
    #[serde(rename = "smtpHost")]
    smtp_host: String,
    #[serde(rename = "smtpPort")]
    smtp_port: i64,
    #[serde(rename = "smtpSecurity")]
    smtp_security: String,
    username: Option<String>,
    password: String,
    #[serde(rename = "acceptInvalidCerts", default)]
    accept_invalid_certs: bool,
}

async fn create(State(state): State<AppState>, Json(req): Json<CreateMailbox>) -> Response {
    let id = new_id();
    let enc = server_crypto::encrypt(&req.password);
    let mut control = state.control.lock().await;
    let result = sqlx::query(
        "INSERT INTO mailboxes (id, owner_user_id, email, display_name, imap_host, imap_port, \
         imap_security, smtp_host, smtp_port, smtp_security, username, password_enc, accept_invalid_certs) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    )
    .bind(&id)
    .bind(&req.owner_user_id)
    .bind(&req.email)
    .bind(&req.display_name)
    .bind(&req.imap_host)
    .bind(req.imap_port)
    .bind(&req.imap_security)
    .bind(&req.smtp_host)
    .bind(req.smtp_port)
    .bind(&req.smtp_security)
    .bind(&req.username)
    .bind(&enc)
    .bind(if req.accept_invalid_certs { 1 } else { 0 })
    .execute(&mut *control)
    .await;

    match result {
        Ok(_) => Json(json!({ "id": id })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Failed to create mailbox: {e}") })),
        )
            .into_response(),
    }
}

async fn delete_mailbox(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut control = state.control.lock().await;
    let _ = sqlx::query("DELETE FROM mailboxes WHERE id = $1")
        .bind(&id)
        .execute(&mut *control)
        .await;
    Json(json!({ "ok": true })).into_response()
}

// ---------- member endpoint ----------

async fn list_mine(
    State(state): State<AppState>,
    Extension(user): Extension<User>,
) -> Response {
    let mut control = state.control.lock().await;
    // Admin sees all mailboxes; members see only their own.
    let rows = if user.is_admin() {
        sqlx::query_as::<_, MailboxRow>("SELECT * FROM mailboxes ORDER BY email")
            .fetch_all(&mut *control)
            .await
    } else {
        sqlx::query_as::<_, MailboxRow>(
            "SELECT * FROM mailboxes WHERE owner_user_id = $1 ORDER BY email",
        )
        .bind(&user.id)
        .fetch_all(&mut *control)
        .await
    }
    .unwrap_or_default();
    let views: Vec<MailboxView> = rows.iter().map(MailboxView::from).collect();
    Json(views).into_response()
}

// ---------- server-side credential resolution (used by email_api) ----------

/// True if `user` is allowed to operate on mailbox `m`.
fn can_access(user: &User, m: &MailboxRow) -> bool {
    user.is_admin() || m.owner_user_id == user.id
}

/// Resolve a mailbox id into an ImapConfig, enforcing ownership.
pub async fn resolve_imap(
    state: &AppState,
    user: &User,
    mailbox_id: &str,
) -> Result<ImapConfig, String> {
    let m = fetch_mailbox(state, mailbox_id)
        .await
        .ok_or_else(|| "Mailbox not found".to_string())?;
    if !can_access(user, &m) {
        return Err("Not authorized for this mailbox".to_string());
    }
    let username = m.login_username();
    let password = server_crypto::decrypt(&m.password_enc)?;
    Ok(ImapConfig {
        host: m.imap_host,
        port: m.imap_port as u16,
        security: m.imap_security,
        username,
        password,
        auth_method: "password".to_string(),
        accept_invalid_certs: m.accept_invalid_certs != 0,
    })
}

/// Resolve a mailbox id into an SmtpConfig, enforcing ownership.
pub async fn resolve_smtp(
    state: &AppState,
    user: &User,
    mailbox_id: &str,
) -> Result<SmtpConfig, String> {
    let m = fetch_mailbox(state, mailbox_id)
        .await
        .ok_or_else(|| "Mailbox not found".to_string())?;
    if !can_access(user, &m) {
        return Err("Not authorized for this mailbox".to_string());
    }
    let username = m.login_username();
    let password = server_crypto::decrypt(&m.password_enc)?;
    Ok(SmtpConfig {
        host: m.smtp_host,
        port: m.smtp_port as u16,
        security: m.smtp_security,
        username,
        password,
        auth_method: "password".to_string(),
        accept_invalid_certs: m.accept_invalid_certs != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::MailboxRow;

    fn row(username: Option<&str>) -> MailboxRow {
        MailboxRow {
            id: "m1".into(),
            owner_user_id: "u1".into(),
            email: "test@example.com".into(),
            display_name: None,
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            imap_security: "tls".into(),
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            smtp_security: "tls".into(),
            username: username.map(|s| s.to_string()),
            password_enc: String::new(),
            accept_invalid_certs: 0,
        }
    }

    #[test]
    fn login_username_falls_back_to_email_when_none() {
        assert_eq!(row(None).login_username(), "test@example.com");
    }

    #[test]
    fn login_username_falls_back_when_empty_or_whitespace() {
        // The admin form submits "" when the field is left blank — must fall back.
        assert_eq!(row(Some("")).login_username(), "test@example.com");
        assert_eq!(row(Some("   ")).login_username(), "test@example.com");
    }

    #[test]
    fn login_username_uses_explicit_value() {
        assert_eq!(row(Some("custom-login")).login_username(), "custom-login");
    }
}
