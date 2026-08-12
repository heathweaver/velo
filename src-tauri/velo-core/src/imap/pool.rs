//! Per-account IMAP session pool.
//!
//! Every operation used to be `connect → operate → logout`, so a sync of a
//! large mailbox performed one full TCP + TLS + LOGIN cycle per 200-message
//! chunk, and every user action opened yet another connection alongside it.
//! Servers cap concurrent connections per user (Dovecot's default is 10) and
//! penalise rapid re-login, so under a big sync the pressure showed up as
//! commands timing out — which is how a delete could report success while the
//! server still held the message.
//!
//! Sessions are keyed by the credentials that produced them and handed out one
//! at a time. A checked-out session is owned by the caller until it is
//! returned, which also serialises access: IMAP is a stateful protocol where
//! SELECT applies to the whole connection, so two concurrent callers sharing
//! one session would operate on each other's mailbox.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::client::{self, ImapSession};
use super::types::ImapConfig;

/// How long an unused session is kept before being dropped.
///
/// Servers close idle IMAP connections on their own — 30 minutes is a common
/// default — and a session that has been sitting for a while is more likely to
/// be dead than useful. Ten minutes keeps a working session alive across a
/// sync and the user actions around it without holding connections open for
/// hours.
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// Identifies the account a session belongs to.
///
/// The password is deliberately not part of the key but *is* compared before
/// reuse: a changed password must not silently reuse a session authenticated
/// with the old one, but nor should credentials be spread across a map key.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct SessionKey {
    host: String,
    port: u16,
    username: String,
}

impl SessionKey {
    fn from_config(config: &ImapConfig) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            username: config.username.clone(),
        }
    }
}

struct PooledSession {
    session: ImapSession,
    /// The secret this session was authenticated with, so a credential change
    /// invalidates it rather than being silently ignored.
    secret: String,
    last_used: Instant,
}

#[derive(Default)]
struct PoolInner {
    idle: HashMap<SessionKey, PooledSession>,
}

/// A pool of authenticated IMAP sessions.
#[derive(Clone, Default)]
pub struct SessionPool {
    inner: Arc<Mutex<PoolInner>>,
}

fn secret_of(config: &ImapConfig) -> String {
    // This field holds a password or an OAuth access token depending on
    // auth_method. OAuth tokens are refreshed per call, so comparing it is also
    // what stops a session authenticated with an expired token being reused.
    config.password.clone()
}

impl SessionPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take a session for this account, reusing an idle one when possible.
    ///
    /// A reused session is verified with NOOP first. Servers drop idle
    /// connections without telling the client, so handing back a stale session
    /// would turn one dead connection into a failed user action.
    pub async fn check_out(&self, config: &ImapConfig) -> Result<ImapSession, String> {
        let key = SessionKey::from_config(config);
        let secret = secret_of(config);

        let reusable = {
            let mut inner = self.inner.lock().await;
            inner
                .idle
                .remove(&key)
                .filter(|pooled| may_reuse(&pooled.secret, &secret, pooled.last_used.elapsed()))
        };

        if let Some(pooled) = reusable {
            let mut session = pooled.session;
            if client::is_alive(&mut session).await {
                return Ok(session);
            }
            // Dead on arrival — drop it and fall through to a fresh login.
            let _ = session.logout().await;
        }

        let _ = key;
        client::connect(config).await
    }

    /// Return a healthy session for reuse.
    ///
    /// Only call this after the operation succeeded. A session left mid-command
    /// or pointed at the wrong mailbox is worse to reuse than a fresh login, so
    /// failure paths simply drop it — which is also what the previous
    /// connect-per-call code did, since `?` skipped its logout too.
    pub async fn check_in(&self, config: &ImapConfig, session: ImapSession) {
        let mut inner = self.inner.lock().await;
        inner.idle.insert(
            SessionKey::from_config(config),
            PooledSession {
                session,
                secret: secret_of(config),
                last_used: Instant::now(),
            },
        );
    }

    /// Drop every idle session, logging out politely where possible.
    ///
    /// Used when an account's credentials change or it is removed, so the pool
    /// cannot keep talking to a server the user has disconnected from.
    pub async fn evict_all(&self) {
        let sessions: Vec<PooledSession> = {
            let mut inner = self.inner.lock().await;
            inner.idle.drain().map(|(_, v)| v).collect()
        };
        for pooled in sessions {
            let mut session = pooled.session;
            let _ = session.logout().await;
        }
    }

    /// Number of sessions currently held idle. Exposed for tests and diagnostics.
    pub async fn idle_count(&self) -> usize {
        self.inner.lock().await.idle.len()
    }
}

/// Whether an idle session may be handed out again.
///
/// Split out from the pool so it can be tested: the pool itself holds live
/// sockets, and the two things that must never go wrong here — reusing a
/// session authenticated with a credential the user has since changed, and
/// reusing one the server has almost certainly dropped — are both decided
/// entirely by this function.
fn may_reuse(pooled_secret: &str, current_secret: &str, idle_for: Duration) -> bool {
    pooled_secret == current_secret && idle_for < IDLE_TIMEOUT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_a_fresh_session_with_the_same_credentials() {
        assert!(may_reuse("hunter2", "hunter2", Duration::from_secs(30)));
    }

    #[test]
    fn refuses_a_session_authenticated_with_an_old_credential() {
        // A changed password, or a refreshed OAuth token, must not be served by
        // a session that logged in with the previous one.
        assert!(!may_reuse("old-token", "new-token", Duration::from_secs(1)));
    }

    #[test]
    fn refuses_a_session_that_has_been_idle_too_long() {
        // Servers drop idle connections silently; past the timeout a fresh
        // login is cheaper than discovering the socket is dead mid-command.
        assert!(!may_reuse("hunter2", "hunter2", IDLE_TIMEOUT));
        assert!(!may_reuse("hunter2", "hunter2", IDLE_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn keeps_a_session_right_up_to_the_timeout() {
        assert!(may_reuse("hunter2", "hunter2", IDLE_TIMEOUT - Duration::from_secs(1)));
    }

    #[tokio::test]
    async fn starts_empty_and_reports_its_size() {
        let pool = SessionPool::new();
        assert_eq!(pool.idle_count().await, 0);
    }
}
