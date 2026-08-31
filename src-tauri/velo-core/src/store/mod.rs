//! Message storage.
//!
//! Sync used to write mail one statement at a time from the frontend: a
//! placeholder thread, a message, then a row per attachment, each its own IPC
//! round trip into the SQL plugin and its own implicit transaction. A chunk of
//! fifty messages cost several hundred crossings of that boundary, and every one
//! of them competed for SQLite's single write lock with whatever else the app
//! was doing.
//!
//! Here a whole chunk arrives as one call and is written inside one transaction,
//! so the boundary is crossed once and the write lock is taken once.
//!
//! The caller still decides *what* a chunk is; this module only writes it.

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

/// An attachment belonging to a message in the chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub id: String,
    pub message_id: String,
    pub account_id: String,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub gmail_attachment_id: Option<String>,
    pub content_id: Option<String>,
    pub is_inline: bool,
}

/// One message from a fetched chunk, with everything needed to store it.
///
/// `thread_id` is the placeholder the message is parked under until threading
/// runs — normally the message's own id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub account_id: String,
    pub thread_id: String,
    pub from_address: Option<String>,
    pub from_name: Option<String>,
    pub to_addresses: Option<String>,
    pub cc_addresses: Option<String>,
    pub bcc_addresses: Option<String>,
    pub reply_to: Option<String>,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub raw_size: Option<i64>,
    pub internal_date: Option<i64>,
    pub list_unsubscribe: Option<String>,
    pub list_unsubscribe_post: Option<String>,
    pub auth_results: Option<String>,
    pub message_id_header: Option<String>,
    pub references_header: Option<String>,
    pub in_reply_to_header: Option<String>,
    pub imap_uid: Option<i64>,
    pub imap_folder: Option<String>,
    #[serde(default)]
    pub attachments: Vec<StoredAttachment>,
}

/// Thread row written before the message, so the foreign key holds.
///
/// A placeholder describes a thread of exactly one message, which is all that is
/// known before threading runs. It is upserted rather than inserted because the
/// same message can be re-fetched — a folder rescan, a widened sync window —
/// and must not fail the second time.
const UPSERT_THREAD: &str = "INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = $3, snippet = $4, last_message_at = $5, message_count = $6,
       is_read = $7, is_starred = $8, is_important = $9, has_attachments = $10";

/// Deliberately identical to the statement the frontend used to issue, down to
/// the COALESCE guards: a re-fetch that arrives without a body must not blank
/// the body already stored.
const UPSERT_MESSAGE: &str = "INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, auth_results, message_id_header, references_header, in_reply_to_header, imap_uid, imap_folder)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
     ON CONFLICT(account_id, id) DO UPDATE SET
       from_address = $4, from_name = $5, to_addresses = $6, cc_addresses = $7,
       bcc_addresses = $8, reply_to = $9, subject = $10, snippet = $11,
       date = $12, is_read = $13, is_starred = $14,
       body_html = COALESCE($15, body_html), body_text = COALESCE($16, body_text),
       body_cached = CASE WHEN $15 IS NOT NULL THEN 1 ELSE body_cached END,
       raw_size = $18, internal_date = $19, list_unsubscribe = $20, list_unsubscribe_post = $21,
       auth_results = $22, message_id_header = COALESCE($23, message_id_header),
       references_header = COALESCE($24, references_header),
       in_reply_to_header = COALESCE($25, in_reply_to_header),
       imap_uid = COALESCE($26, imap_uid), imap_folder = COALESCE($27, imap_folder)";

const UPSERT_ATTACHMENT: &str = "INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, gmail_attachment_id, content_id, is_inline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT(id) DO UPDATE SET
       filename = $4, mime_type = $5, size = $6,
       gmail_attachment_id = $7, content_id = $8, is_inline = $9";

/// Write a fetched chunk: placeholder thread, message and attachments for each.
///
/// All of it in one transaction, so a chunk is either stored or not. A partial
/// chunk is worse than none: the messages it did write are already on disk, so
/// the next sync will not fetch them again, and they would sit under
/// placeholders forever.
///
/// Returns how many messages were written.
pub async fn store_chunk(pool: &SqlitePool, messages: &[StoredMessage]) -> Result<usize, String> {
    if messages.is_empty() {
        return Ok(0);
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    for msg in messages {
        sqlx::query(UPSERT_THREAD)
            .bind(&msg.thread_id)
            .bind(&msg.account_id)
            .bind(&msg.subject)
            .bind(&msg.snippet)
            .bind(msg.date)
            .bind(1_i64)
            .bind(msg.is_read as i64)
            .bind(msg.is_starred as i64)
            .bind(0_i64)
            .bind(msg.has_attachments as i64)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("thread {}: {e}", msg.thread_id))?;

        sqlx::query(UPSERT_MESSAGE)
            .bind(&msg.id)
            .bind(&msg.account_id)
            .bind(&msg.thread_id)
            .bind(&msg.from_address)
            .bind(&msg.from_name)
            .bind(&msg.to_addresses)
            .bind(&msg.cc_addresses)
            .bind(&msg.bcc_addresses)
            .bind(&msg.reply_to)
            .bind(&msg.subject)
            .bind(&msg.snippet)
            .bind(msg.date)
            .bind(msg.is_read as i64)
            .bind(msg.is_starred as i64)
            .bind(&msg.body_html)
            .bind(&msg.body_text)
            // body_cached: a body arriving now is a cached body.
            .bind(msg.body_html.is_some() as i64)
            .bind(msg.raw_size)
            .bind(msg.internal_date)
            .bind(&msg.list_unsubscribe)
            .bind(&msg.list_unsubscribe_post)
            .bind(&msg.auth_results)
            .bind(&msg.message_id_header)
            .bind(&msg.references_header)
            .bind(&msg.in_reply_to_header)
            .bind(msg.imap_uid)
            .bind(&msg.imap_folder)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("message {}: {e}", msg.id))?;

        for att in &msg.attachments {
            sqlx::query(UPSERT_ATTACHMENT)
                .bind(&att.id)
                .bind(&att.message_id)
                .bind(&att.account_id)
                .bind(&att.filename)
                .bind(&att.mime_type)
                .bind(att.size)
                .bind(&att.gmail_attachment_id)
                .bind(&att.content_id)
                .bind(att.is_inline as i64)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("attachment {}: {e}", att.id))?;
        }
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(messages.len())
}

/// Count of stored messages for an account — used to tell "sync stored nothing"
/// apart from "the query could not answer", which once cost an account its sync
/// state.
pub async fn message_count(pool: &SqlitePool, account_id: &str) -> Result<i64, String> {
    let row: SqliteRow = sqlx::query("SELECT COUNT(*) AS n FROM messages WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.try_get::<i64, _>("n").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// The columns these statements touch, as the app's migrations create them.
    const SCHEMA: &str = "
        CREATE TABLE threads (
            id TEXT NOT NULL, account_id TEXT NOT NULL, subject TEXT, snippet TEXT,
            last_message_at INTEGER, message_count INTEGER DEFAULT 1,
            is_read INTEGER DEFAULT 0, is_starred INTEGER DEFAULT 0,
            is_important INTEGER DEFAULT 0, has_attachments INTEGER DEFAULT 0,
            PRIMARY KEY (account_id, id)
        );
        CREATE TABLE messages (
            id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
            from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT,
            bcc_addresses TEXT, reply_to TEXT, subject TEXT, snippet TEXT,
            date INTEGER NOT NULL, is_read INTEGER DEFAULT 0, is_starred INTEGER DEFAULT 0,
            body_html TEXT, body_text TEXT, body_cached INTEGER DEFAULT 0,
            raw_size INTEGER, internal_date INTEGER, list_unsubscribe TEXT,
            list_unsubscribe_post TEXT, auth_results TEXT, message_id_header TEXT,
            references_header TEXT, in_reply_to_header TEXT, imap_uid INTEGER,
            imap_folder TEXT,
            PRIMARY KEY (account_id, id),
            FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
            subject, from_name, from_address, body_text, snippet,
            content='messages', content_rowid='rowid'
        );
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
            VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
            VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
            INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
            VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
        END;
        CREATE TABLE attachments (
            id TEXT PRIMARY KEY, message_id TEXT NOT NULL, account_id TEXT NOT NULL,
            filename TEXT, mime_type TEXT, size INTEGER, gmail_attachment_id TEXT,
            content_id TEXT, is_inline INTEGER DEFAULT 0
        );
    ";

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(SCHEMA).execute(&pool).await.unwrap();
        pool
    }

    fn message(id: &str) -> StoredMessage {
        StoredMessage {
            id: id.to_string(),
            account_id: "acc-1".to_string(),
            thread_id: id.to_string(),
            from_address: Some("sender@example.com".to_string()),
            from_name: Some("Sender".to_string()),
            to_addresses: None,
            cc_addresses: None,
            bcc_addresses: None,
            reply_to: None,
            subject: Some("Subject".to_string()),
            snippet: Some("Snippet".to_string()),
            date: 1_700_000_000,
            is_read: false,
            is_starred: false,
            has_attachments: false,
            body_html: Some("<p>Body</p>".to_string()),
            body_text: Some("Body".to_string()),
            raw_size: Some(1024),
            internal_date: Some(1_700_000_000),
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            auth_results: None,
            message_id_header: Some("<m1@example.com>".to_string()),
            references_header: None,
            in_reply_to_header: None,
            imap_uid: Some(42),
            imap_folder: Some("INBOX".to_string()),
            attachments: vec![],
        }
    }

    #[tokio::test]
    async fn stores_a_message_under_a_placeholder_thread() {
        let pool = pool().await;

        let stored = store_chunk(&pool, &[message("m1")]).await.unwrap();

        assert_eq!(stored, 1);
        let row = sqlx::query("SELECT thread_id, subject, imap_uid, body_cached FROM messages WHERE id = 'm1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("thread_id"), "m1");
        assert_eq!(row.get::<String, _>("subject"), "Subject");
        assert_eq!(row.get::<i64, _>("imap_uid"), 42);
        // A body arrived, so the message counts as cached.
        assert_eq!(row.get::<i64, _>("body_cached"), 1);
        // The thread has to exist or the foreign key would have refused the row.
        let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(threads, 1);
    }

    #[tokio::test]
    async fn stores_attachments_with_their_message() {
        let pool = pool().await;
        let mut msg = message("m1");
        msg.has_attachments = true;
        msg.attachments = vec![StoredAttachment {
            id: "m1_att1".to_string(),
            message_id: "m1".to_string(),
            account_id: "acc-1".to_string(),
            filename: Some("invoice.pdf".to_string()),
            mime_type: Some("application/pdf".to_string()),
            size: Some(2048),
            gmail_attachment_id: Some("att1".to_string()),
            content_id: None,
            is_inline: false,
        }];

        store_chunk(&pool, &[msg]).await.unwrap();

        let filename: String =
            sqlx::query_scalar("SELECT filename FROM attachments WHERE id = 'm1_att1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(filename, "invoice.pdf");
    }

    #[tokio::test]
    async fn a_refetch_without_a_body_keeps_the_stored_one() {
        // A message re-fetched by a header-only pass must not lose its body.
        let pool = pool().await;
        store_chunk(&pool, &[message("m1")]).await.unwrap();

        let mut bodyless = message("m1");
        bodyless.body_html = None;
        bodyless.body_text = None;
        store_chunk(&pool, &[bodyless]).await.unwrap();

        let body: Option<String> =
            sqlx::query_scalar("SELECT body_html FROM messages WHERE id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(body.as_deref(), Some("<p>Body</p>"));
    }

    #[tokio::test]
    async fn re_storing_the_same_chunk_is_harmless() {
        // Folder rescans and widened sync windows re-fetch mail that is already
        // stored; the second pass must update rather than fail.
        let pool = pool().await;
        store_chunk(&pool, &[message("m1")]).await.unwrap();
        store_chunk(&pool, &[message("m1")]).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn a_failing_message_takes_the_whole_chunk_with_it() {
        // Half a chunk is worse than none: the messages already written would
        // never be fetched again, and would sit under placeholders forever.
        let pool = pool().await;
        let mut bad = message("m2");
        bad.account_id = String::new();
        // NOT NULL is satisfied by an empty string, so force a real failure by
        // pointing the message at a thread the chunk does not create.
        sqlx::query("CREATE TRIGGER reject_m2 BEFORE INSERT ON messages WHEN NEW.id = 'm2' BEGIN SELECT RAISE(ABORT, 'nope'); END")
            .execute(&pool)
            .await
            .unwrap();

        let result = store_chunk(&pool, &[message("m1"), bad]).await;

        assert!(result.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn a_stored_message_is_searchable() {
        // The database carries FTS triggers that index messages as they land.
        // Writing from here rather than from the frontend must not bypass them,
        // or search would quietly stop finding new mail.
        let pool = pool().await;
        store_chunk(&pool, &[message("m1")]).await.unwrap();

        let hits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'Subject'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(hits, 1);
    }

    #[tokio::test]
    async fn counts_only_the_account_asked_about() {
        let pool = pool().await;
        let mut other = message("m2");
        other.account_id = "acc-2".to_string();
        store_chunk(&pool, &[message("m1"), other]).await.unwrap();

        assert_eq!(message_count(&pool, "acc-1").await.unwrap(), 1);
        assert_eq!(message_count(&pool, "acc-2").await.unwrap(), 1);
        assert_eq!(message_count(&pool, "gone").await.unwrap(), 0);
    }
}
