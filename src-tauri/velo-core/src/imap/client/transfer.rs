//! Raw-TCP IMAP session used to move a message between two accounts
//! (Apple-Mail style cross-account move): fetch the full RFC822 source with
//! its flags and INTERNALDATE, APPEND it to the destination folder, then —
//! only after the APPEND succeeded — `UID STORE +FLAGS (\Deleted)` and
//! `UID EXPUNGE <uid>` on the source copy.
//!
//! Raw TCP is used (like `raw_fetch_messages`) because async-imap's UID FETCH
//! returns no items on some servers (DreamHost). Every string argument goes
//! through `imap_quote`. This module never CREATEs or DELETEs folders, and
//! never issues a plain `EXPUNGE` (which would purge other `\Deleted` mail).

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{
    connect_stream, extract_bracket_number, imap_quote, raw_connect_starttls,
    raw_parse_fetch_responses, ImapStream,
};
use crate::imap::types::ImapConfig;

/// A full source message ready to be appended elsewhere.
#[derive(Debug, Clone)]
pub struct TransferMessage {
    pub uid: u32,
    /// Flags to carry over (already filtered, see [`transfer_flags`]).
    pub flags: Vec<String>,
    /// INTERNALDATE as sent by the source server, if valid.
    pub internal_date: Option<String>,
    /// Message-ID header value (with angle brackets), if present.
    pub message_id: Option<String>,
    pub body: Vec<u8>,
}

/// Minimal raw IMAP session (one connection, sequential tagged commands).
pub struct RawImapSession {
    reader: BufReader<ImapStream>,
    tag: u32,
    capabilities: String,
    selected: Option<String>,
    uidvalidity: u32,
}

impl RawImapSession {
    /// Connect and authenticate (password LOGIN with quoted args, or XOAUTH2).
    pub async fn connect(config: &ImapConfig) -> Result<Self, String> {
        let stream = if config.security == "starttls" {
            raw_connect_starttls(config).await?
        } else {
            connect_stream(config).await?
        };
        let mut reader = BufReader::new(stream);
        if config.security != "starttls" {
            let mut line = String::new();
            tokio::time::timeout(std::time::Duration::from_secs(30), reader.read_line(&mut line))
                .await
                .map_err(|_| "greeting: timeout".to_string())?
                .map_err(|e| format!("greeting: {e}"))?;
        }
        let mut s = RawImapSession { reader, tag: 0, capabilities: String::new(), selected: None, uidvalidity: 0 };
        let login = if config.auth_method == "oauth2" {
            let xoauth2 = format!("user={}\x01auth=Bearer {}\x01\x01", config.username, config.password);
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, xoauth2.as_bytes());
            format!("AUTHENTICATE XOAUTH2 {b64}")
        } else {
            format!("LOGIN {} {}", imap_quote(&config.username), imap_quote(&config.password))
        };
        // Never echo the LOGIN line in errors (it contains the password).
        s.command(&login).await.map_err(|_| "IMAP login failed".to_string())?;
        let caps = s.command("CAPABILITY").await?;
        s.capabilities = caps
            .lines()
            .filter(|l| l.starts_with("* CAPABILITY"))
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase();
        Ok(s)
    }

    fn next_tag(&mut self) -> String {
        self.tag += 1;
        format!("v{}", self.tag)
    }

    /// Send one tagged command line; return all response lines on OK.
    async fn command(&mut self, cmd: &str) -> Result<String, String> {
        let tag = self.next_tag();
        let line = format!("{tag} {cmd}\r\n");
        super::raw_send_and_wait(&mut self.reader, line.as_bytes(), &tag).await
    }

    pub fn has_capability(&self, cap: &str) -> bool {
        self.capabilities
            .split_whitespace()
            .any(|c| c == cap.to_uppercase())
    }

    /// SELECT a folder (fails if it does not exist — never creates it).
    /// Returns UIDVALIDITY.
    pub async fn select(&mut self, folder: &str) -> Result<u32, String> {
        if self.selected.as_deref() == Some(folder) {
            return Ok(self.uidvalidity);
        }
        let resp = self
            .command(&format!("SELECT {}", imap_quote(folder)))
            .await
            .map_err(|e| format!("SELECT {folder}: {e}"))?;
        self.uidvalidity = resp
            .lines()
            .find_map(|l| extract_bracket_number(l, "UIDVALIDITY"))
            .unwrap_or(0);
        self.selected = Some(folder.to_string());
        Ok(self.uidvalidity)
    }

    /// Fetch the complete message (BODY.PEEK[] — does not set \Seen) with
    /// FLAGS and INTERNALDATE from the selected folder. `None` if the UID no
    /// longer exists.
    pub async fn fetch_full(&mut self, uid: u32) -> Result<Option<TransferMessage>, String> {
        let tag = self.next_tag();
        let cmd = format!("{tag} UID FETCH {uid} (UID FLAGS INTERNALDATE BODY.PEEK[])\r\n");
        self.reader
            .get_mut()
            .write_all(cmd.as_bytes())
            .await
            .map_err(|e| format!("FETCH write: {e}"))?;
        let msgs = raw_parse_fetch_responses(&mut self.reader, &tag).await?;
        let Some(m) = msgs.into_iter().find(|m| m.uid == uid) else {
            return Ok(None);
        };
        Ok(Some(TransferMessage {
            uid,
            flags: transfer_flags(&m.flags_raw),
            internal_date: m.internal_date_raw.filter(|d| valid_internal_date(d)),
            message_id: header_message_id(&m.body),
            body: m.body,
        }))
    }

    /// UIDs in the selected folder whose Message-ID header contains `message_id`.
    pub async fn search_message_id(&mut self, message_id: &str) -> Result<Vec<u32>, String> {
        let resp = self
            .command(&format!("UID SEARCH HEADER Message-ID {}", imap_quote(message_id)))
            .await?;
        Ok(parse_search_response(&resp))
    }

    /// APPEND a message to `folder`, preserving flags and INTERNALDATE.
    /// Uses a synchronizing literal. Never creates the folder (a `NO
    /// [TRYCREATE]` is returned as an error).
    pub async fn append(
        &mut self,
        folder: &str,
        flags: &[String],
        internal_date: Option<&str>,
        body: &[u8],
    ) -> Result<(), String> {
        let tag = self.next_tag();
        let cmd = build_append_command(&tag, folder, flags, internal_date, body.len());
        let w = self.reader.get_mut();
        w.write_all(cmd.as_bytes()).await.map_err(|e| format!("APPEND write: {e}"))?;
        // Wait for the continuation request before sending the literal.
        loop {
            let mut line = String::new();
            match tokio::time::timeout(std::time::Duration::from_secs(30), self.reader.read_line(&mut line)).await {
                Ok(Ok(0)) => return Err("APPEND: connection closed".into()),
                Ok(Ok(_)) => {
                    if line.starts_with('+') {
                        break;
                    }
                    if line.starts_with(&format!("{tag} ")) {
                        return Err(format!("APPEND rejected: {}", line.trim()));
                    }
                }
                Ok(Err(e)) => return Err(format!("APPEND read: {e}")),
                Err(_) => return Err("APPEND: timeout waiting for continuation".into()),
            }
        }
        let w = self.reader.get_mut();
        w.write_all(body).await.map_err(|e| format!("APPEND literal: {e}"))?;
        w.write_all(b"\r\n").await.map_err(|e| format!("APPEND literal: {e}"))?;
        w.flush().await.map_err(|e| format!("APPEND flush: {e}"))?;
        // Tagged completion (raw_send_and_wait with an empty write).
        let ok = format!("{tag} OK");
        loop {
            let mut line = String::new();
            match tokio::time::timeout(std::time::Duration::from_secs(120), self.reader.read_line(&mut line)).await {
                Ok(Ok(0)) => return Err("APPEND: connection closed".into()),
                Ok(Ok(_)) => {
                    if line.starts_with(&ok) {
                        return Ok(());
                    }
                    if line.starts_with(&format!("{tag} ")) {
                        return Err(format!("APPEND failed: {}", line.trim()));
                    }
                }
                Ok(Err(e)) => return Err(format!("APPEND read: {e}")),
                Err(_) => return Err("APPEND: timeout".into()),
            }
        }
    }

    /// Remove ONE message from the selected folder: `UID STORE +FLAGS.SILENT
    /// (\Deleted)` then `UID EXPUNGE <uid>` (UIDPLUS). Without UIDPLUS the
    /// message is left flagged `\Deleted` and `Ok(false)` is returned — a
    /// plain EXPUNGE is never sent because it would purge unrelated mail.
    pub async fn delete_uid(&mut self, uid: u32) -> Result<bool, String> {
        self.command(&format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)")).await?;
        if !self.has_capability("UIDPLUS") {
            return Ok(false);
        }
        self.command(&format!("UID EXPUNGE {uid}")).await?;
        Ok(true)
    }

    pub async fn logout(mut self) {
        let _ = self.command("LOGOUT").await;
    }
}

/// Build the APPEND command line up to and including the literal marker.
pub(crate) fn build_append_command(
    tag: &str,
    folder: &str,
    flags: &[String],
    internal_date: Option<&str>,
    len: usize,
) -> String {
    let mut cmd = format!("{tag} APPEND {}", imap_quote(folder));
    if !flags.is_empty() {
        cmd.push_str(&format!(" ({})", flags.join(" ")));
    }
    if let Some(d) = internal_date.filter(|d| valid_internal_date(d)) {
        cmd.push_str(&format!(" {}", imap_quote(d)));
    }
    cmd.push_str(&format!(" {{{len}}}\r\n"));
    cmd
}

/// Flags to carry across: system flags \Seen \Answered \Flagged \Draft plus
/// keyword atoms ($Label1, $Forwarded, ...). Drops \Recent (server-only),
/// \Deleted (would hide the copy), `\*`, and anything that isn't a clean atom.
pub fn transfer_flags(flags_raw: &str) -> Vec<String> {
    const SYSTEM: [&str; 4] = ["\\Seen", "\\Answered", "\\Flagged", "\\Draft"];
    let mut out: Vec<String> = Vec::new();
    for f in flags_raw.split_whitespace() {
        let keep = if f.starts_with('\\') {
            SYSTEM.iter().any(|s| s.eq_ignore_ascii_case(f))
        } else {
            f.chars().all(|c| c.is_ascii_graphic() && !"(){%*\"\\]".contains(c))
        };
        if keep && !out.iter().any(|o| o.eq_ignore_ascii_case(f)) {
            out.push(f.to_string());
        }
    }
    out
}

/// True for an IMAP date-time body like `16-Feb-2026 12:00:00 +0000`
/// (day may be space-padded). Anything else is dropped rather than sent.
pub fn valid_internal_date(d: &str) -> bool {
    (20..=26).contains(&d.len())
        && d.chars().all(|c| c.is_ascii_alphanumeric() || " -:+".contains(c))
        && super::parse_imap_date(d.trim()).is_some()
}

/// Message-ID header value (unfolded, trimmed) from raw RFC822 bytes.
pub fn header_message_id(raw: &[u8]) -> Option<String> {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n"))
        .unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut value: Option<String> = None;
    for line in head.lines() {
        if let Some(v) = value.as_mut() {
            if line.starts_with(' ') || line.starts_with('\t') {
                v.push_str(line.trim());
                continue;
            }
            break;
        }
        if let Some((name, rest)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("message-id") {
                value = Some(rest.trim().to_string());
            }
        }
    }
    value.filter(|v| !v.is_empty() && !v.contains(['\r', '\n']))
}

/// UIDs from `* SEARCH 1 2 3` lines.
pub fn parse_search_response(resp: &str) -> Vec<u32> {
    resp.lines()
        .filter_map(|l| l.strip_prefix("* SEARCH"))
        .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect::<Vec<u32>>())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_filtered_for_append() {
        assert_eq!(
            transfer_flags("\\Seen \\Recent \\Deleted $Label1 \\Flagged \\* \\Answered \\seen"),
            vec!["\\Seen", "$Label1", "\\Flagged", "\\Answered"]
        );
        assert!(transfer_flags("").is_empty());
        assert!(transfer_flags("bad\"kw (x)").is_empty());
    }

    #[test]
    fn internal_date_validation() {
        assert!(valid_internal_date("16-Feb-2026 12:00:00 +0000"));
        assert!(valid_internal_date(" 6-Oct-2026 09:01:02 -0700"));
        assert!(!valid_internal_date("16-Feb-2026 12:00:00 +0000\" x"));
        assert!(!valid_internal_date("garbage"));
    }

    #[test]
    fn append_command_quotes_folder_and_date() {
        let c = build_append_command(
            "v3",
            "INBOX.My \"Q\"",
            &["\\Seen".into(), "$Label1".into()],
            Some("16-Feb-2026 12:00:00 +0000"),
            42,
        );
        assert_eq!(c, "v3 APPEND \"INBOX.My \\\"Q\\\"\" (\\Seen $Label1) \"16-Feb-2026 12:00:00 +0000\" {42}\r\n");
        let c = build_append_command("v1", "INBOX", &[], Some("bad\"date"), 7);
        assert_eq!(c, "v1 APPEND \"INBOX\" {7}\r\n");
    }

    #[test]
    fn message_id_extraction() {
        let raw = b"From: a@b.com\r\nMessage-ID:\r\n <abc@x.com>\r\nSubject: hi\r\n\r\nMessage-ID: <body@x>\r\n";
        assert_eq!(header_message_id(raw).as_deref(), Some("<abc@x.com>"));
        let raw = b"message-id: <k@y>\nSubject: s\n\nbody";
        assert_eq!(header_message_id(raw).as_deref(), Some("<k@y>"));
        assert_eq!(header_message_id(b"Subject: none\r\n\r\nMessage-ID: <no@x>"), None);
    }

    #[test]
    fn search_parse() {
        assert_eq!(parse_search_response("* SEARCH 4 19\r\nv2 OK done\r\n"), vec![4, 19]);
        assert!(parse_search_response("* SEARCH\r\nv2 OK\r\n").is_empty());
    }
}
