//! New-mail email notifier.
//!
//! A background task polls each provisioned mailbox's INBOX. When new messages
//! arrive, it sends an email — FROM the admin's mailbox — to the mailbox owner's
//! login email, containing a link that opens that message directly in the
//! browser (`<base>/#/mail/INBOX?notify=<mailboxId>:<uid>`).
//!
//! State (last-seen UID per mailbox) is kept in the control DB so restarts don't
//! re-notify. The first poll of a new mailbox just records the high-water mark
//! (no backfill spam).
//!
//! Config:
//!   VELO_PUBLIC_URL       base URL users click back to (e.g. https://mail.example.com)
//!   VELO_NOTIFY_INTERVAL  seconds between polls (default 120)
//!   VELO_NOTIFY           set to "0" to disable

use std::time::Duration;

use velo_core::imap::scheduler::Priority;
use velo_core::ops;
use velo_core::ImapMessage;

use crate::mailboxes::{self, MailboxCreds};
use crate::state::AppState;

pub async fn migrate(conn: &mut sqlx::SqliteConnection) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notify_state (
            mailbox_id TEXT PRIMARY KEY,
            last_uid INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create notify_state table failed");
}

/// Spawn the background poller. No-op if VELO_NOTIFY=0.
pub fn spawn(state: AppState) {
    if std::env::var("VELO_NOTIFY").as_deref() == Ok("0") {
        tracing::info!("New-mail notifier disabled (VELO_NOTIFY=0)");
        return;
    }
    let interval = std::env::var("VELO_NOTIFY_INTERVAL")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(120);

    tokio::spawn(async move {
        tracing::info!("New-mail notifier polling every {interval}s");
        let mut tick = tokio::time::interval(Duration::from_secs(interval));
        loop {
            tick.tick().await;
            if let Err(e) = poll_once(&state).await {
                tracing::warn!("notifier poll failed: {e}");
            }
        }
    });
}

async fn get_last_uid(state: &AppState, mailbox_id: &str) -> Option<u32> {
    let mut control = state.control.lock().await;
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT last_uid FROM notify_state WHERE mailbox_id = $1")
            .bind(mailbox_id)
            .fetch_optional(&mut *control)
            .await
            .ok()
            .flatten();
    row.map(|(u,)| u as u32)
}

async fn set_last_uid(state: &AppState, mailbox_id: &str, uid: u32) {
    let mut control = state.control.lock().await;
    let _ = sqlx::query(
        "INSERT INTO notify_state (mailbox_id, last_uid) VALUES ($1, $2) \
         ON CONFLICT(mailbox_id) DO UPDATE SET last_uid = $2",
    )
    .bind(mailbox_id)
    .bind(uid as i64)
    .execute(&mut *control)
    .await;
}

/// One polling pass over all mailboxes.
async fn poll_once(state: &AppState) -> Result<(), String> {
    let sender = mailboxes::admin_sender(state).await;
    let mailboxes = mailboxes::all_with_creds(state).await;

    for mb in mailboxes {
        if let Err(e) = poll_mailbox(state, &mb, sender.as_ref()).await {
            tracing::warn!("notifier: mailbox {} failed: {e}", mb.email);
        }
    }
    Ok(())
}

async fn poll_mailbox(
    state: &AppState,
    mb: &MailboxCreds,
    sender: Option<&MailboxCreds>,
) -> Result<(), String> {
    // Current highest UID in INBOX.
    let status = ops::imap_get_folder_status(mb.imap.clone(), "INBOX".to_string(), Priority::Background).await?;
    let high = status.uidnext.saturating_sub(1);

    let last = match get_last_uid(state, &mb.id).await {
        Some(u) => u,
        None => {
            // First sight of this mailbox: record high-water mark, don't backfill.
            set_last_uid(state, &mb.id, high).await;
            return Ok(());
        }
    };

    if high <= last {
        return Ok(());
    }

    // Fetch the UIDs newer than `last`.
    let new_uids =
        ops::imap_fetch_new_uids(mb.imap.clone(), "INBOX".to_string(), last, Priority::Background).await?;
    if new_uids.is_empty() {
        set_last_uid(state, &mb.id, high).await;
        return Ok(());
    }

    // Resolve the recipient (mailbox owner's login email) and the sender mailbox.
    let to = match state.user_email(&mb.owner_user_id).await {
        Some(e) => e,
        None => {
            set_last_uid(state, &mb.id, high).await;
            return Ok(());
        }
    };
    let sender = match sender {
        Some(s) => s,
        None => {
            // No admin mailbox to send from — just advance the marker.
            tracing::warn!("notifier: no admin sender mailbox; skipping email");
            set_last_uid(state, &mb.id, high).await;
            return Ok(());
        }
    };

    // Notify per new message (fetch a little metadata for the subject line).
    let mut max_uid = last;
    for uid in new_uids {
        max_uid = max_uid.max(uid);
        let meta =
            ops::imap_fetch_message_body(mb.imap.clone(), "INBOX".to_string(), uid, Priority::Background).await;
        let (subject, from) = match meta {
            Ok(m) => message_summary(&m),
            Err(_) => ("New message".to_string(), mb.email.clone()),
        };
        if let Err(e) = send_notification(sender, &to, &mb.id, uid, &subject, &from).await {
            tracing::warn!("notifier: failed to email {to}: {e}");
        }
    }

    set_last_uid(state, &mb.id, max_uid.max(high)).await;
    Ok(())
}

fn message_summary(m: &ImapMessage) -> (String, String) {
    let subject = m.subject.clone().unwrap_or_else(|| "(no subject)".to_string());
    let from = m
        .from_name
        .clone()
        .or_else(|| m.from_address.clone())
        .unwrap_or_else(|| "Unknown sender".to_string());
    (subject, from)
}

/// Build + send the notification email through the admin mailbox's SMTP.
async fn send_notification(
    sender: &MailboxCreds,
    to: &str,
    mailbox_id: &str,
    uid: u32,
    subject: &str,
    from: &str,
) -> Result<(), String> {
    let base = std::env::var("VELO_PUBLIC_URL").unwrap_or_default();
    // Hash-router deep link the SPA understands; ?notify carries mailbox:uid.
    let link = format!("{base}/#/mail/INBOX?notify={mailbox_id}:{uid}");

    let html = format!(
        "<p>You have a new email in <b>{mb}</b>.</p>\
         <p><b>From:</b> {from}<br><b>Subject:</b> {subj}</p>\
         <p><a href=\"{link}\">Open it in Velo</a></p>",
        mb = html_escape(&sender_label(to)),
        from = html_escape(from),
        subj = html_escape(subject),
        link = link,
    );
    let text = format!(
        "New email\nFrom: {from}\nSubject: {subject}\n\nOpen: {link}"
    );

    let raw = build_raw_email(
        &sender.email,
        to,
        &format!("New email: {subject}"),
        &html,
        &text,
    );
    let raw_b64url = base64_url_encode(raw.as_bytes());

    let result = ops::smtp_send_email(sender.smtp.clone(), raw_b64url).await?;
    if !result.success {
        return Err(result.message);
    }
    Ok(())
}

fn sender_label(to: &str) -> String {
    to.to_string()
}

/// Minimal RFC822 builder for the notification (plain alternative + html).
fn build_raw_email(from: &str, to: &str, subject: &str, html: &str, text: &str) -> String {
    let boundary = "velo_notify_boundary_8f3a";
    let date = httpdate_now();
    format!(
        "From: {from}\r\n\
         To: {to}\r\n\
         Subject: {subject}\r\n\
         Date: {date}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\
         \r\n\
         --{boundary}\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         \r\n\
         {text}\r\n\
         --{boundary}\r\n\
         Content-Type: text/html; charset=UTF-8\r\n\
         \r\n\
         {html}\r\n\
         --{boundary}--\r\n"
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// RFC 2822 date for the Date header (avoids pulling in extra deps).
fn httpdate_now() -> String {
    // `time` is already a dependency (axum-extra cookie). Use it for formatting.
    use time::format_description::well_known::Rfc2822;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Rfc2822)
        .unwrap_or_else(|_| "Thu, 01 Jan 1970 00:00:00 +0000".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_email_is_well_formed_multipart() {
        let raw = build_raw_email(
            "admin@ex.com",
            "mark@ex.com",
            "New email: Order #5",
            "<p>hi</p>",
            "hi",
        );
        assert!(raw.contains("From: admin@ex.com\r\n"));
        assert!(raw.contains("To: mark@ex.com\r\n"));
        assert!(raw.contains("Subject: New email: Order #5\r\n"));
        assert!(raw.contains("multipart/alternative"));
        assert!(raw.contains("text/plain"));
        assert!(raw.contains("text/html"));
    }

    #[test]
    fn html_escaping_blocks_injection() {
        let s = html_escape("<script>&\"x\"");
        assert!(!s.contains("<script>"));
        assert!(s.contains("&lt;script&gt;"));
        assert!(s.contains("&amp;"));
    }

    #[test]
    fn base64url_has_no_unsafe_chars() {
        let enc = base64_url_encode(b"hello>world?");
        assert!(!enc.contains('+'));
        assert!(!enc.contains('/'));
        assert!(!enc.contains('='));
    }
}
