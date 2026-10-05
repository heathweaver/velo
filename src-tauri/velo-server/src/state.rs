//! Control database + app state.
//!
//! The **control DB** (`VELO_CONTROL_DB`, default `velo-control.db`) is
//! server-only — no browser can ever query it. It holds:
//!   - `users`      — login accounts (admin / member) with Argon2 password hashes
//!   - `sessions`   — opaque session tokens → user
//!
//! Each user's *mailbox* data lives in a **separate per-user data DB**
//! (`data-{userId}.db`), opened on demand and cached. Isolation is by file
//! boundary: a member's SQL physically cannot reach another user's data.
//!
//! IMAP/SMTP credentials are NOT stored here yet; they live in each user's data
//! DB (the existing `accounts` table) exactly as on desktop. A later step can
//! move them into a control-only table if we want them fully unreachable from
//! the browser; for now the per-user file boundary already prevents
//! cross-user access.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rand::RngCore;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub type Conn = Arc<Mutex<sqlx::SqliteConnection>>;

#[derive(Clone)]
pub struct AppState {
    /// Server-only control DB connection (users, sessions).
    pub control: Conn,
    /// Cache of opened per-user data DB connections, keyed by user id.
    pub user_dbs: Arc<Mutex<HashMap<String, Conn>>>,
    /// Directory where per-user data DB files live.
    pub data_dir: PathBuf,
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub role: String, // "admin" | "member"
    pub password_hash: String,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

async fn open_sqlite(path: &str) -> sqlx::SqliteConnection {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::ConnectOptions;
    use std::str::FromStr;

    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))
        .expect("invalid sqlite path")
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    opts.connect().await.expect("failed to open sqlite db")
}

impl AppState {
    /// Open the control DB, run its migrations, and bootstrap the admin user
    /// from VELO_ADMIN_EMAIL / VELO_ADMIN_PASSWORD if no admin exists yet.
    pub async fn init(control_path: &str, data_dir: PathBuf) -> Self {
        let mut conn = open_sqlite(control_path).await;
        control_migrate(&mut conn).await;
        crate::profile::migrate(&mut conn).await;
        crate::notifier::migrate(&mut conn).await;
        crate::filer::migrate(&mut conn).await;

        let state = AppState {
            control: Arc::new(Mutex::new(conn)),
            user_dbs: Arc::new(Mutex::new(HashMap::new())),
            data_dir,
        };
        state.bootstrap_admin().await;
        state
    }

    async fn bootstrap_admin(&self) {
        let email = std::env::var("VELO_ADMIN_EMAIL").ok();
        let password = std::env::var("VELO_ADMIN_PASSWORD").ok();
        let (email, password) = match (email, password) {
            (Some(e), Some(p)) if !e.is_empty() && !p.is_empty() => (e, p),
            _ => return,
        };

        let mut control = self.control.lock().await;
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
                .fetch_optional(&mut *control)
                .await
                .expect("control query failed");
        if existing.is_some() {
            return; // an admin already exists
        }

        let id = new_id();
        let hash = hash_password(&password);
        sqlx::query(
            "INSERT INTO users (id, email, display_name, role, password_hash) \
             VALUES ($1, $2, $3, 'admin', $4)",
        )
        .bind(&id)
        .bind(&email)
        .bind(Option::<String>::None)
        .bind(&hash)
        .execute(&mut *control)
        .await
        .expect("failed to create admin user");
        tracing::info!("Bootstrapped admin user {email}");
    }

    /// Look up a user's email by id (server-internal).
    pub async fn user_email(&self, user_id: &str) -> Option<String> {
        let mut control = self.control.lock().await;
        let row: Option<(String,)> = sqlx::query_as("SELECT email FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&mut *control)
            .await
            .ok()
            .flatten();
        row.map(|(e,)| e)
    }

    /// Get (opening + caching if needed) the data DB connection for a user.
    pub async fn user_db(&self, user_id: &str) -> Conn {
        let mut map = self.user_dbs.lock().await;
        if let Some(conn) = map.get(user_id) {
            return conn.clone();
        }
        let path = self.data_dir.join(format!("data-{user_id}.db"));
        let conn = open_sqlite(path.to_str().expect("non-utf8 data path")).await;
        let conn = Arc::new(Mutex::new(conn));
        map.insert(user_id.to_string(), conn.clone());
        conn
    }
}

/// Control-DB schema. Kept tiny and stable; the per-user mailbox schema is the
/// existing frontend migrations, run through the SQL gateway.
async fn control_migrate(conn: &mut sqlx::SqliteConnection) {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            display_name TEXT,
            role TEXT NOT NULL CHECK (role IN ('admin','member')),
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create users table failed");

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create sessions table failed");

    // Provisioned IMAP/SMTP mailboxes. Credentials live here (server-only),
    // encrypted with the server secret key. A mailbox is owned by one user; the
    // browser only ever references it by id. The admin manages these; members
    // can use but not edit them.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mailboxes (
            id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            display_name TEXT,
            imap_host TEXT NOT NULL,
            imap_port INTEGER NOT NULL,
            imap_security TEXT NOT NULL,
            smtp_host TEXT NOT NULL,
            smtp_port INTEGER NOT NULL,
            smtp_security TEXT NOT NULL,
            username TEXT,
            password_enc TEXT NOT NULL,
            accept_invalid_certs INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )",
    )
    .execute(&mut *conn)
    .await
    .expect("create mailboxes table failed");
}

// ---------- password hashing ----------

pub fn hash_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("hashing failed")
        .to_string()
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

// ---------- id / token generation ----------

pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
