//! End-to-end: a real TLS + WebSocket server driven by the same client
//! transport the desktop and mobile apps use. Covers pairing, session-token
//! reconnects, request/response, server-pushed events reaching every
//! connected client, and certificate pinning.

use std::sync::Arc;
use std::time::Duration;

use claudette::db::Database;
use claudette::model::Repository;
use claudette::plugin_runtime::PluginRegistry;
use claudette::transport::Transport;
use claudette::transport::ws::WebSocketTransport;
use claudette_server::ws::ServerState;
use claudette_server::{ServerHandle, ServerOptions, StandaloneHost};
use serde_json::{Value, json};

struct Fixture {
    _dirs: Vec<tempfile::TempDir>,
    handle: ServerHandle,
    pairing_token: String,
    repo: Repository,
}

async fn setup() -> Fixture {
    let repo_dir = tempfile::tempdir().unwrap();
    for args in [
        &["init", "-b", "main"][..],
        &["config", "user.email", "test@test.com"],
        &["config", "user.name", "Test"],
    ] {
        git(repo_dir.path(), args).await;
    }
    std::fs::write(repo_dir.path().join("README.md"), "# test").unwrap();
    git(repo_dir.path(), &["add", "-A"]).await;
    git(repo_dir.path(), &["commit", "-m", "initial"]).await;

    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let worktree_base = state_dir.path().join("workspaces");
    std::fs::create_dir_all(&worktree_base).unwrap();
    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        name: "test".to_string(),
        path: repo_dir.path().to_string_lossy().to_string(),
        path_slug: "test".to_string(),
        icon: None,
        created_at: "0".to_string(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        archive_script: None,
        archive_script_auto_run: false,
        base_branch: None,
        default_remote: None,
        required_inputs: None,
        path_valid: true,
    };
    Database::open(&db_path)
        .unwrap()
        .insert_repository(&repo)
        .unwrap();

    let host = Arc::new(StandaloneHost {
        state: Arc::new(ServerState::new_with_plugins(
            db_path,
            worktree_base,
            PluginRegistry::discover(state_dir.path()),
        )),
    });

    let config_dir = tempfile::tempdir().unwrap();
    let handle = claudette_server::start(
        ServerOptions {
            port: 0,
            bind: "127.0.0.1".into(),
            name: Some("test-server".into()),
            no_mdns: true,
            config_path: Some(config_dir.path().join("server.toml")),
            tls_dir: Some(config_dir.path().to_path_buf()),
        },
        host,
    )
    .await
    .unwrap();
    let pairing_token = handle
        .connection_string
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();

    Fixture {
        _dirs: vec![repo_dir, state_dir, config_dir],
        handle,
        pairing_token,
        repo,
    }
}

async fn git(cwd: &std::path::Path, args: &[&str]) {
    let status = claudette::process::command("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .await
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

async fn call(t: &WebSocketTransport, method: &str, params: Value) -> Value {
    let resp = t
        .send(json!({"method": method, "params": params}))
        .await
        .unwrap();
    assert!(resp.get("error").is_none(), "{method} failed: {resp}");
    resp["result"].clone()
}

#[tokio::test]
async fn pair_reconnect_rpc_and_broadcast_events() {
    let f = setup().await;

    // Pair with the one-time-display pairing token.
    let first = WebSocketTransport::connect("127.0.0.1", f.handle.port, None)
        .await
        .unwrap();
    assert_eq!(first.cert_fingerprint, f.handle.cert_fingerprint);
    let a = first.transport;
    let auth = a
        .authenticate_pairing(&f.pairing_token, "client-a")
        .await
        .unwrap();
    assert_eq!(auth.server_name, "test-server");
    let session_token = auth.session_token.unwrap();

    // A second client reconnects with a pinned cert + session token.
    let b =
        WebSocketTransport::connect("127.0.0.1", f.handle.port, Some(&f.handle.cert_fingerprint))
            .await
            .unwrap()
            .transport;
    b.authenticate_session(&session_token).await.unwrap();

    let initial = call(&a, "load_initial_data", json!({})).await;
    assert_eq!(initial["repositories"][0]["id"], f.repo.id);

    let created = call(
        &a,
        "create_workspace",
        json!({"repository_id": f.repo.id, "name": "e2e"}),
    )
    .await;
    let workspace = &created["workspace"];
    let sessions = call(
        &b,
        "list_chat_sessions",
        json!({"workspace_id": workspace["id"]}),
    )
    .await;
    assert_eq!(sessions[0]["id"], created["default_session_id"]);

    // A terminal opened by client A streams to client B as well.
    let mut b_events = b.event_stream();
    let pty = call(
        &a,
        "spawn_pty",
        json!({
            "workspace_id": workspace["id"],
            "cwd": workspace["worktree_path"],
        }),
    )
    .await;
    let pty_id = pty["pty_id"].as_u64().unwrap();
    call(
        &a,
        "write_pty",
        json!({"pty_id": pty_id, "data": b"echo e2e-marker\n".to_vec()}),
    )
    .await;

    let mut seen = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !seen.contains("e2e-marker") {
        let event = tokio::time::timeout_at(deadline, b_events.recv())
            .await
            .expect("timed out waiting for pty-output")
            .unwrap();
        if event.event == "pty-output" && event.payload["pty_id"] == pty_id {
            let bytes: Vec<u8> = serde_json::from_value(event.payload["data"].clone()).unwrap();
            seen.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    call(&a, "close_pty", json!({"pty_id": pty_id})).await;

    // Server-side errors come back as JSON-RPC errors, not silence.
    let resp = a
        .send(json!({"method": "no_such_method", "params": {}}))
        .await
        .unwrap();
    assert_eq!(resp["error"]["message"], "Unknown method: no_such_method");
}

#[tokio::test]
async fn wrong_pairing_token_and_pinned_fingerprint_mismatch_are_rejected() {
    let f = setup().await;

    let t = WebSocketTransport::connect("127.0.0.1", f.handle.port, None)
        .await
        .unwrap()
        .transport;
    assert!(t.authenticate_pairing("not-the-token", "x").await.is_err());

    let pinned = WebSocketTransport::connect("127.0.0.1", f.handle.port, Some("00ff")).await;
    assert!(pinned.is_err(), "a changed certificate must be refused");
}

#[tokio::test]
async fn stopping_the_server_disconnects_established_clients() {
    let mut f = setup().await;
    let t = WebSocketTransport::connect("127.0.0.1", f.handle.port, None)
        .await
        .unwrap()
        .transport;
    t.authenticate_pairing(&f.pairing_token, "x").await.unwrap();
    let mut closed = t.closed();

    // "Stop sharing" must cut off paired clients, not just new ones.
    f.handle.stop();
    tokio::time::timeout(Duration::from_secs(5), closed.wait_for(|c| *c))
        .await
        .expect("server stop never closed the client")
        .unwrap();
    assert!(!t.is_connected());
    assert!(t.send(json!({"method": "x"})).await.is_err());
}

#[tokio::test]
async fn revoked_session_token_no_longer_authenticates() {
    let f = setup().await;
    let t = WebSocketTransport::connect("127.0.0.1", f.handle.port, None)
        .await
        .unwrap()
        .transport;
    let token = t
        .authenticate_pairing(&f.pairing_token, "x")
        .await
        .unwrap()
        .session_token
        .unwrap();
    assert_eq!(call(&t, "revoke_session", json!({})).await["revoked"], true);

    let again = WebSocketTransport::connect("127.0.0.1", f.handle.port, None)
        .await
        .unwrap()
        .transport;
    assert!(again.authenticate_session(&token).await.is_err());
}
