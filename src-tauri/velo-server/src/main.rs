//! velo-server — self-hosted web backend for Velo.
//!
//! Serves the built frontend and the JSON API the browser talks to. All mail is
//! IMAP/SMTP. Access is per-user: an admin creates users and (later) assigns
//! mailboxes; each user's mailbox data lives in its own SQLite file, so members
//! can only ever see their own mail.
//!
//! Run with:  cargo run -p velo-server
//! Env:
//!   VELO_BIND           bind address              (default 127.0.0.1:8080)
//!   VELO_CONTROL_DB     control DB (users/sessions) (default ./velo-control.db)
//!   VELO_DATA_DIR       per-user data DB directory  (default ./data)
//!   VELO_STATIC_DIR     built frontend dir          (optional)
//!   VELO_ADMIN_EMAIL    bootstrap admin email       (first run only)
//!   VELO_ADMIN_PASSWORD bootstrap admin password    (first run only)

mod auth;
mod db_gateway;
mod email_api;
mod mailboxes;
mod notifier;
mod oauth_api;
mod profile;
mod server_crypto;
mod state;
mod filer;

use axum::{routing::get, Router};
use state::AppState;
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                // Include velo_core so IMAP/SMTP diagnostics are visible.
                .unwrap_or_else(|_| "velo_server=info,velo_core=info,tower_http=info".into()),
        )
        .init();

    // velo-core logs via the `log` crate; bridge those records into tracing so
    // they appear in the same output as the server's tracing logs.
    let _ = tracing_log::LogTracer::init();

    let control_db =
        std::env::var("VELO_CONTROL_DB").unwrap_or_else(|_| "velo-control.db".to_string());
    let data_dir = PathBuf::from(std::env::var("VELO_DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(&data_dir).expect("failed to create VELO_DATA_DIR");

    // Server secret key (for encrypting stored mailbox passwords) lives next to
    // the control DB, or comes from VELO_SECRET_KEY.
    let key_file = data_dir.join("velo-secret.key");
    server_crypto::init_key(&key_file);

    let state = AppState::init(&control_db, data_dir).await;

    // Background: email users when new mail arrives in their mailbox.
    notifier::spawn(state.clone());

    // Optional Reads filer (VELO_FILER=1). Default off.
    filer::spawn(state.clone());

    let app = build_app(state);

    // Bind address resolution, in priority order:
    //   1. VELO_BIND (explicit host:port)
    //   2. PORT (set by Railway/Render/Heroku-style hosts) → 0.0.0.0:$PORT
    //   3. default 127.0.0.1:8080
    let bind = std::env::var("VELO_BIND").unwrap_or_else(|_| {
        std::env::var("PORT")
            .map(|p| format!("0.0.0.0:{p}"))
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
    });
    let addr: SocketAddr = bind.parse().expect("bind address must be valid host:port");

    tracing::info!("velo-server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    axum::serve(listener, app).await.expect("server error");
}

/// Build the full application router. Separated from `main` so tests can drive
/// it without binding a socket.
fn build_app(state: AppState) -> Router {
    // Protected API (any signed-in user): email commands, SQL gateway, and the
    // member "my mailboxes" list (passwords never included).
    let protected = Router::new()
        .merge(email_api::router(state.clone()))
        .nest("/oauth", oauth_api::router())
        .nest("/db", db_gateway::router(state.clone()))
        .merge(mailboxes::member_router(state.clone()))
        .merge(profile::member_router(state.clone()))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_user,
        ));

    // Admin-only API: provisioned mailbox management + profile (display name /
    // signature, global or per-user) + Reads filing rules.
    let admin_only = Router::new()
        .nest("/admin", mailboxes::admin_router(state.clone()))
        .nest("/admin", profile::admin_router(state.clone()))
        .nest("/admin", filer::admin_router(state.clone()))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_admin,
        ));

    // Public/self-scoped API: health + auth (login/logout/me) + admin user mgmt
    // (admin routes are guarded inside auth::router).
    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(auth::router(state.clone()))
        .merge(admin_only)
        .merge(protected);

    let mut app = Router::new().nest("/api", api).layer(CorsLayer::permissive());

    // Optionally serve the built frontend (single-page app) from VELO_STATIC_DIR.
    // Unknown paths fall back to index.html so client-side routes (e.g. /settings)
    // load the SPA instead of 404ing.
    if let Ok(dir) = std::env::var("VELO_STATIC_DIR") {
        let index = format!("{dir}/index.html");
        app = app.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index)));
    }

    app
}

#[cfg(test)]
mod tests {
    use super::build_app;
    use crate::state::AppState;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use base64::Engine;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use tower::ServiceExt;

    /// Build an app backed by temp control + data DBs and a bootstrapped admin.
    async fn test_app() -> (axum::Router, PathBuf) {
        let dir = std::env::temp_dir().join(format!("velo-test-{}", crate::state::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("VELO_ADMIN_EMAIL", "admin@example.com");
        std::env::set_var("VELO_ADMIN_PASSWORD", "admin-pass-123");
        // Fixed key so mailbox-password encryption works deterministically in tests.
        std::env::set_var(
            "VELO_SECRET_KEY",
            base64::engine::general_purpose::STANDARD.encode([9u8; 32]),
        );
        crate::server_crypto::init_key(&dir.join("unused.key"));
        let control = dir.join("control.db");
        let state = AppState::init(control.to_str().unwrap(), dir.clone()).await;
        (build_app(state), dir)
    }

    async fn send(app: &axum::Router, req: Request<Body>) -> (StatusCode, Value, Vec<String>) {
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let cookies: Vec<String> = resp
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let val: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, val, cookies)
    }

    fn json_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn login(app: &axum::Router, email: &str, password: &str) -> String {
        let (status, _, cookies) =
            send(app, json_post("/api/auth/login", json!({ "email": email, "password": password })))
                .await;
        assert_eq!(status, StatusCode::OK, "login should succeed");
        // Extract the session cookie value (name=value before the first ';').
        cookies
            .iter()
            .find(|c| c.starts_with("velo_session="))
            .map(|c| c.split(';').next().unwrap().to_string())
            .expect("session cookie set")
    }

    #[tokio::test]
    async fn health_is_public() {
        let (app, _d) = test_app().await;
        let (status, _, _) = send(
            &app,
            Request::builder().uri("/api/health").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn db_gateway_requires_auth() {
        let (app, _d) = test_app().await;
        let (status, _, _) = send(
            &app,
            json_post("/api/db/select", json!({ "query": "SELECT 1", "params": [] })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn admin_can_login_and_fetch_me() {
        let (app, _d) = test_app().await;
        let cookie = login(&app, "admin@example.com", "admin-pass-123").await;
        let (status, body, _) = send(
            &app,
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["role"], "admin");
        assert_eq!(body["email"], "admin@example.com");
    }

    #[tokio::test]
    async fn bad_password_rejected() {
        let (app, _d) = test_app().await;
        let (status, _, _) = send(
            &app,
            json_post("/api/auth/login", json!({ "email": "admin@example.com", "password": "wrong" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn member_cannot_use_admin_routes() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;

        // Admin creates a member.
        let (status, body, _) = send(
            &app,
            {
                let mut r = json_post(
                    "/api/admin/users",
                    json!({ "email": "mark@example.com", "password": "mark-pass-123", "role": "member" }),
                );
                r.headers_mut().insert("cookie", admin.parse().unwrap());
                r
            },
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["role"], "member");

        // Member logs in and is forbidden from listing users.
        let member = login(&app, "mark@example.com", "mark-pass-123").await;
        let (status, _, _) = send(
            &app,
            Request::builder()
                .uri("/api/admin/users")
                .header("cookie", &member)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn each_user_has_isolated_data_db() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        send(
            &app,
            {
                let mut r = json_post(
                    "/api/admin/users",
                    json!({ "email": "mark@example.com", "password": "mark-pass-123" }),
                );
                r.headers_mut().insert("cookie", admin.parse().unwrap());
                r
            },
        )
        .await;
        let member = login(&app, "mark@example.com", "mark-pass-123").await;

        // Admin writes into their own data DB.
        let mut create = json_post(
            "/api/db/execute",
            json!({ "query": "CREATE TABLE t (v TEXT)", "params": [] }),
        );
        create.headers_mut().insert("cookie", admin.parse().unwrap());
        send(&app, create).await;
        let mut ins = json_post(
            "/api/db/execute",
            json!({ "query": "INSERT INTO t (v) VALUES ('admin-secret')", "params": [] }),
        );
        ins.headers_mut().insert("cookie", admin.parse().unwrap());
        send(&app, ins).await;

        // The member's data DB does not have that table — proves file isolation.
        let mut sel = json_post(
            "/api/db/select",
            json!({ "query": "SELECT v FROM t", "params": [] }),
        );
        sel.headers_mut().insert("cookie", member.parse().unwrap());
        let (status, body, _) = send(&app, sel).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY); // "no such table: t" in member DB
        assert!(body["error"].as_str().unwrap().contains("no such table"));
    }

    #[tokio::test]
    async fn sql_gateway_fts5_trigram_available() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mut r = json_post(
            "/api/db/execute",
            json!({ "query": "CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='trigram')", "params": [] }),
        );
        r.headers_mut().insert("cookie", admin.parse().unwrap());
        let (status, _, _) = send(&app, r).await;
        assert_eq!(status, StatusCode::OK, "FTS5 + trigram must be available");
    }

    #[tokio::test]
    async fn sql_gateway_recovers_from_dangling_transaction() {
        // Simulate a page closed between BEGIN and COMMIT: a BEGIN with no
        // matching COMMIT leaves the shared connection mid-transaction. A later
        // BEGIN must still succeed (the gateway rolls back the dangling one)
        // rather than failing with "cannot start a transaction within a
        // transaction".
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;

        let begin = |cookie: &str| {
            let mut r = json_post("/api/db/execute", json!({ "query": "BEGIN TRANSACTION", "params": [] }));
            r.headers_mut().insert("cookie", cookie.parse().unwrap());
            r
        };

        // First BEGIN, never committed → connection left in a transaction.
        let (s1, _, _) = send(&app, begin(&admin)).await;
        assert_eq!(s1, StatusCode::OK);

        // Second BEGIN previously 502'd; now it must recover and succeed.
        let (s2, _, _) = send(&app, begin(&admin)).await;
        assert_eq!(s2, StatusCode::OK, "gateway must recover from a dangling transaction");

        // And normal writes work afterwards.
        let mut commit = json_post("/api/db/execute", json!({ "query": "COMMIT", "params": [] }));
        commit.headers_mut().insert("cookie", admin.parse().unwrap());
        let (s3, _, _) = send(&app, commit).await;
        assert_eq!(s3, StatusCode::OK);
    }

    /// Helper: admin creates a member and returns their user id.
    async fn create_member(app: &axum::Router, admin: &str, email: &str, pw: &str) -> String {
        let mut r = json_post(
            "/api/admin/users",
            json!({ "email": email, "password": pw, "role": "member" }),
        );
        r.headers_mut().insert("cookie", admin.parse().unwrap());
        let (status, body, _) = send(app, r).await;
        assert_eq!(status, StatusCode::OK);
        body["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn admin_provisions_mailbox_password_never_exposed() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mark_id = create_member(&app, &admin, "mark@ex.com", "markpass123").await;

        // Admin creates Mark's mailbox.
        let mut r = json_post(
            "/api/admin/mailboxes",
            json!({
                "ownerUserId": mark_id, "email": "mark@ex.com",
                "imapHost": "imap.ex.com", "imapPort": 993, "imapSecurity": "tls",
                "smtpHost": "smtp.ex.com", "smtpPort": 465, "smtpSecurity": "tls",
                "password": "super-secret-imap-pw"
            }),
        );
        r.headers_mut().insert("cookie", admin.parse().unwrap());
        let (status, _, _) = send(&app, r).await;
        assert_eq!(status, StatusCode::OK);

        // Member lists their mailboxes — config present, password absent.
        let member = login(&app, "mark@ex.com", "markpass123").await;
        let (status, body, _) = send(
            &app,
            Request::builder()
                .uri("/api/mailboxes")
                .header("cookie", &member)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mb = &body[0];
        assert_eq!(mb["email"], "mark@ex.com");
        assert_eq!(mb["imapHost"], "imap.ex.com");
        // Critically: no password / password_enc anywhere in the response.
        let serialized = body.to_string();
        assert!(!serialized.contains("super-secret-imap-pw"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("passwordEnc"));
    }

    #[tokio::test]
    async fn member_cannot_provision_mailboxes() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        let member = login(&app, "mark@ex.com", "markpass123").await;

        let mut r = json_post(
            "/api/admin/mailboxes",
            json!({
                "ownerUserId": "anyone", "email": "x@ex.com",
                "imapHost": "h", "imapPort": 993, "imapSecurity": "tls",
                "smtpHost": "h", "smtpPort": 465, "smtpSecurity": "tls", "password": "p"
            }),
        );
        r.headers_mut().insert("cookie", member.parse().unwrap());
        let (status, _, _) = send(&app, r).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn member_only_sees_own_mailboxes() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mark_id = create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        let jane_id = create_member(&app, &admin, "jane@ex.com", "janepass123").await;

        for (owner, email) in [(&mark_id, "mark@ex.com"), (&jane_id, "jane@ex.com")] {
            let mut r = json_post(
                "/api/admin/mailboxes",
                json!({
                    "ownerUserId": owner, "email": email,
                    "imapHost": "imap.ex.com", "imapPort": 993, "imapSecurity": "tls",
                    "smtpHost": "smtp.ex.com", "smtpPort": 465, "smtpSecurity": "tls",
                    "password": "pw"
                }),
            );
            r.headers_mut().insert("cookie", admin.parse().unwrap());
            send(&app, r).await;
        }

        // Mark sees only his mailbox.
        let mark = login(&app, "mark@ex.com", "markpass123").await;
        let (_, body, _) = send(
            &app,
            Request::builder()
                .uri("/api/mailboxes")
                .header("cookie", &mark)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(body.as_array().unwrap().len(), 1);
        assert_eq!(body[0]["email"], "mark@ex.com");
    }

    /// Helper: admin creates a mailbox for an owner, returns its id.
    async fn create_mailbox(app: &axum::Router, admin: &str, owner: &str, email: &str) -> String {
        let mut r = json_post(
            "/api/admin/mailboxes",
            json!({
                "ownerUserId": owner, "email": email,
                "imapHost": "imap.ex.com", "imapPort": 993, "imapSecurity": "tls",
                "smtpHost": "smtp.ex.com", "smtpPort": 465, "smtpSecurity": "tls",
                "password": "pw"
            }),
        );
        r.headers_mut().insert("cookie", admin.parse().unwrap());
        let (_, body, _) = send(app, r).await;
        body["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn member_cannot_use_another_users_mailbox_id() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mark_id = create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        create_member(&app, &admin, "jane@ex.com", "janepass123").await;
        // Mailbox owned by Mark.
        let mark_box = create_mailbox(&app, &admin, &mark_id, "mark@ex.com").await;

        // Jane (a different member) tries to operate on Mark's mailbox by id.
        let jane = login(&app, "jane@ex.com", "janepass123").await;
        let mut r = json_post(
            "/api/imap/list_folders",
            json!({ "mailboxId": mark_box }),
        );
        r.headers_mut().insert("cookie", jane.parse().unwrap());
        let (status, body, _) = send(&app, r).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(body["error"].as_str().unwrap().contains("Not authorized"));
    }

    #[tokio::test]
    async fn profile_per_user_overrides_global_field_by_field() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mark_id = create_member(&app, &admin, "mark@ex.com", "markpass123").await;

        // Global: name + signature.
        let mut g = Request::builder()
            .method("PUT")
            .uri("/api/admin/profile/global")
            .header("content-type", "application/json")
            .header("cookie", &admin)
            .body(Body::from(
                json!({ "displayName": "UK Brewery Tours", "signatureHtml": "<p>global sig</p>" })
                    .to_string(),
            ))
            .unwrap();
        g.headers_mut(); // no-op, keep explicit
        let (s, _, _) = send(&app, g).await;
        assert_eq!(s, StatusCode::OK);

        // Per-user: override only the display name (signature left null).
        let u = Request::builder()
            .method("PUT")
            .uri(&format!("/api/admin/profile/user/{mark_id}"))
            .header("content-type", "application/json")
            .header("cookie", &admin)
            .body(Body::from(
                json!({ "displayName": "Mark", "signatureHtml": null }).to_string(),
            ))
            .unwrap();
        send(&app, u).await;

        // Mark's resolved profile: name from per-user, signature from global.
        let mark = login(&app, "mark@ex.com", "markpass123").await;
        let (_, body, _) = send(
            &app,
            Request::builder()
                .uri("/api/profile")
                .header("cookie", &mark)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(body["displayName"], "Mark");
        assert_eq!(body["signatureHtml"], "<p>global sig</p>");
    }

    #[tokio::test]
    async fn member_cannot_set_profile() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        let mark = login(&app, "mark@ex.com", "markpass123").await;

        let r = Request::builder()
            .method("PUT")
            .uri("/api/admin/profile/global")
            .header("content-type", "application/json")
            .header("cookie", &mark)
            .body(Body::from(json!({ "displayName": "hacked" }).to_string()))
            .unwrap();
        let (status, _, _) = send(&app, r).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    fn authed(method: &str, uri: &str, cookie: &str, body: Option<Value>) -> Request<Body> {
        let b = Request::builder()
            .method(method)
            .uri(uri)
            .header("cookie", cookie)
            .header("content-type", "application/json");
        match body {
            Some(v) => b.body(Body::from(v.to_string())).unwrap(),
            None => b.body(Body::empty()).unwrap(),
        }
    }

    #[tokio::test]
    async fn filing_rules_crud() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        let mark_id = create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        let mb = create_mailbox(&app, &admin, &mark_id, "mark@ex.com").await;
        let mb2 = create_mailbox(&app, &admin, &mark_id, "other@ex.com").await;

        // Create with defaults; sender normalized to lowercase.
        let (status, rule, _) = send(
            &app,
            authed("POST", "/api/admin/filing-rules", &admin,
                Some(json!({ "mailboxId": mb, "senderEmail": "News@Letter.COM" }))),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(rule["senderEmail"], "news@letter.com");
        assert_eq!(rule["action"], "move_reads");
        assert_eq!(rule["enabled"], true);
        assert_eq!(rule["notifyBefore"], true);
        assert_eq!(rule["userId"], mark_id.as_str());
        let id = rule["id"].as_str().unwrap().to_string();

        // Duplicate → 409; bad action → 400; unknown mailbox → 404; bad sender → 400.
        let (s, _, _) = send(&app, authed("POST", "/api/admin/filing-rules", &admin,
            Some(json!({ "mailboxId": mb, "senderEmail": "news@letter.com" })))).await;
        assert_eq!(s, StatusCode::CONFLICT);
        let (s, _, _) = send(&app, authed("POST", "/api/admin/filing-rules", &admin,
            Some(json!({ "mailboxId": mb, "senderEmail": "x@y.com", "action": "delete" })))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        let (s, _, _) = send(&app, authed("POST", "/api/admin/filing-rules", &admin,
            Some(json!({ "mailboxId": "nope", "senderEmail": "x@y.com" })))).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _, _) = send(&app, authed("POST", "/api/admin/filing-rules", &admin,
            Some(json!({ "mailboxId": mb, "senderEmail": "not-an-email" })))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);

        // Second mailbox rule (domain wildcard, disabled, no notify).
        let (s, r2, _) = send(&app, authed("POST", "/api/admin/filing-rules", &admin,
            Some(json!({ "mailboxId": mb2, "senderEmail": "@substack.com",
                         "enabled": false, "notifyBefore": false })))).await;
        assert_eq!(s, StatusCode::CREATED);
        assert_eq!(r2["enabled"], false);
        assert_eq!(r2["notifyBefore"], false);

        // List all / filtered.
        let (_, all, _) = send(&app, authed("GET", "/api/admin/filing-rules", &admin, None)).await;
        assert_eq!(all.as_array().unwrap().len(), 2);
        let (_, only, _) = send(&app, authed("GET",
            &format!("/api/admin/filing-rules?mailboxId={mb}"), &admin, None)).await;
        assert_eq!(only.as_array().unwrap().len(), 1);
        assert_eq!(only[0]["id"], id.as_str());

        // PATCH disable + change sender; PUT alias works too.
        let (s, upd, _) = send(&app, authed("PATCH", &format!("/api/admin/filing-rules/{id}"), &admin,
            Some(json!({ "enabled": false, "senderEmail": "Digest@Letter.com" })))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(upd["enabled"], false);
        assert_eq!(upd["senderEmail"], "digest@letter.com");
        assert_eq!(upd["notifyBefore"], true);
        let (s, upd, _) = send(&app, authed("PUT", &format!("/api/admin/filing-rules/{id}"), &admin,
            Some(json!({ "enabled": true })))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(upd["enabled"], true);
        assert_eq!(upd["senderEmail"], "digest@letter.com");

        // Delete, then 404s.
        let (s, _, _) = send(&app, authed("DELETE", &format!("/api/admin/filing-rules/{id}"), &admin, None)).await;
        assert_eq!(s, StatusCode::OK);
        let (s, _, _) = send(&app, authed("DELETE", &format!("/api/admin/filing-rules/{id}"), &admin, None)).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _, _) = send(&app, authed("PATCH", &format!("/api/admin/filing-rules/{id}"), &admin,
            Some(json!({ "enabled": false })))).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn filing_rules_admin_only() {
        let (app, _d) = test_app().await;
        let admin = login(&app, "admin@example.com", "admin-pass-123").await;
        create_member(&app, &admin, "mark@ex.com", "markpass123").await;
        let mark = login(&app, "mark@ex.com", "markpass123").await;
        let (s, _, _) = send(&app, authed("GET", "/api/admin/filing-rules", &mark, None)).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _, _) = send(&app, authed("POST", "/api/admin/filing-rules", &mark,
            Some(json!({ "mailboxId": "x", "senderEmail": "a@b.com" })))).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _, _) = send(
            &app,
            Request::builder().uri("/api/admin/filing-rules").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn filer_migrate_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("velo-test-{}", crate::state::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let control = dir.join("control.db");
        // Init twice on the same file: migrations must not fail on re-run.
        let s1 = AppState::init(control.to_str().unwrap(), dir.clone()).await;
        drop(s1);
        let s2 = AppState::init(control.to_str().unwrap(), dir.clone()).await;
        let mut c = s2.control.lock().await;
        let n: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
             ('filing_rules','filing_state','idx_filing_rules_mailbox_sender')",
        )
        .fetch_one(&mut *c)
        .await
        .unwrap();
        assert_eq!(n.0, 3);
    }
}
