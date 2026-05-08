use std::collections::HashMap;
use std::io::Write as IoWrite;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use claudette::claude_help::ClaudeFlagDef;
use claudette::env_provider::EnvCache;
use claudette::env_provider::types::EnvMap;
use claudette::plugin_runtime::PluginRegistry;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::auth::ServerConfig;
use crate::handler;

/// Server-side application state — mirrors src-tauri's AppState but without Tauri dependencies.
pub struct ServerState {
    pub db_path: PathBuf,
    pub worktree_base_dir: RwLock<PathBuf>,
    pub agents: RwLock<HashMap<String, AgentSessionState>>,
    pub ptys: RwLock<HashMap<u64, PtyHandle>>,
    pub next_pty_id: AtomicU64,
    /// Plugin registry for env-provider (and SCM) dispatch. `None` when
    /// the host opted out of plugin discovery — the handler falls back to
    /// a no-op resolution path so existing tests (and bare deployments
    /// without bundled plugins) keep working.
    pub plugins: Option<RwLock<PluginRegistry>>,
    /// mtime-keyed env cache shared across all env-provider resolutions.
    /// Wrapped in an `Arc` to match the Tauri-side `AppState` shape and
    /// keep ownership cheap when the handler hands a reference into
    /// `resolve_with_registry`.
    pub env_cache: Arc<EnvCache>,
    /// Cached `claude --help` parse, populated lazily on the first
    /// `send_chat_message` call and reused on subsequent turns. Mirrors
    /// the Tauri `AppState::claude_flag_defs` cache; the server doesn't
    /// run an explicit boot-time discovery task because there's no UI
    /// surface here that needs the flags eagerly. `None` means "not yet
    /// attempted"; `Some(Ok(_))` / `Some(Err(_))` cache the result so
    /// repeated turns don't re-spawn `claude --help`.
    pub claude_flag_defs: RwLock<Option<Result<Vec<ClaudeFlagDef>, String>>>,
}

pub struct AgentSessionState {
    /// The workspace this session belongs to.
    pub workspace_id: String,
    /// Claude CLI `--resume` UUID for this agent session. This is the CLI
    /// session ID; the `chat_sessions.id` that keys `ServerState.agents`
    /// is referred to as `chat_session_id` to keep the two distinct.
    pub session_id: String,
    pub turn_count: u32,
    pub active_pid: Option<u32>,
    pub custom_instructions: Option<String>,
    /// Env baked into the agent's spawn at the start of this session.
    /// Subsequent turns compare freshly-resolved env against this
    /// snapshot; on drift, the session is evicted so the next turn
    /// respawns with the new env. Mirrors `AppState::session_resolved_env`
    /// on the Tauri side.
    pub session_resolved_env: EnvMap,
}

pub struct PtyHandle {
    pub writer: Mutex<Box<dyn IoWrite + Send>>,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

impl ServerState {
    /// Construct a `ServerState` without plugin discovery. Used by tests
    /// that don't exercise the env-provider path; production callers
    /// should use `new_with_plugins`.
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            plugins: None,
            env_cache: Arc::new(EnvCache::new()),
            claude_flag_defs: RwLock::new(None),
        }
    }

    /// Construct a `ServerState` with a discovered plugin registry, so
    /// agents launched via the remote server pick up `.envrc` / mise /
    /// dotenv / nix-devshell env activation the same way the Tauri path
    /// does.
    pub fn new_with_plugins(
        db_path: PathBuf,
        worktree_base_dir: PathBuf,
        plugins: PluginRegistry,
    ) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            plugins: Some(RwLock::new(plugins)),
            env_cache: Arc::new(EnvCache::new()),
            claude_flag_defs: RwLock::new(None),
        }
    }

    pub fn next_pty_id(&self) -> u64 {
        self.next_pty_id.fetch_add(1, Ordering::Relaxed)
    }
}

/// Type alias for the writer half of a WebSocket connection.
pub type Writer = tokio::sync::Mutex<
    futures_util::stream::SplitSink<WebSocketStream<TlsStream<TcpStream>>, Message>,
>;

pub async fn send_message(writer: &Writer, value: &serde_json::Value) {
    let text = serde_json::to_string(value).unwrap_or_default();
    let mut w = writer.lock().await;
    let _ = w.send(Message::Text(text.into())).await;
}

/// Accept a TLS connection and upgrade it to WebSocket.
pub async fn handle_tls_connection(
    state: std::sync::Arc<ServerState>,
    config: std::sync::Arc<tokio::sync::Mutex<ServerConfig>>,
    config_path: std::sync::Arc<PathBuf>,
    tls_stream: TlsStream<TcpStream>,
    addr: SocketAddr,
) {
    let ws_stream = match tokio_tungstenite::accept_async(tls_stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[ws] WebSocket handshake failed from {addr}: {e}");
            return;
        }
    };

    println!("[ws] New connection from {addr}");

    let (write, mut read) = ws_stream.split();
    let writer = std::sync::Arc::new(tokio::sync::Mutex::new(write));

    // Phase 1: Authentication (max 3 attempts).
    let mut auth_attempts = 0;
    let max_attempts = 3;
    let mut authenticated = false;

    while auth_attempts < max_attempts {
        let msg = match read.next().await {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | None => {
                println!("[ws] Connection closed during auth from {addr}");
                return;
            }
            _ => continue,
        };

        let request: serde_json::Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(e) => {
                let err = serde_json::json!({
                    "id": null,
                    "error": {"code": -32700, "message": format!("Parse error: {e}")}
                });
                send_message(&writer, &err).await;
                continue;
            }
        };

        let id = request
            .get("id")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");

        if method != "authenticate" {
            let err = serde_json::json!({
                "id": id,
                "error": {"code": -1, "message": "Must authenticate first"}
            });
            send_message(&writer, &err).await;
            auth_attempts += 1;
            continue;
        }

        let params = request.get("params").cloned().unwrap_or_default();

        // Try session token first, then pairing token.
        if let Some(session_token) = params.get("session_token").and_then(|t| t.as_str()) {
            let mut cfg = config.lock().await;
            if cfg.validate_session(session_token) {
                let _ = cfg.save(&config_path);
                let server_name = cfg.server.name.clone();
                drop(cfg);

                let resp = serde_json::json!({
                    "id": id,
                    "result": {"server_name": server_name}
                });
                send_message(&writer, &resp).await;
                authenticated = true;
                break;
            }
            drop(cfg);
        }

        if let Some(pairing_token) = params.get("pairing_token").and_then(|t| t.as_str()) {
            let client_name = params
                .get("client_name")
                .and_then(|n| n.as_str())
                .unwrap_or("Unknown client");

            let mut cfg = config.lock().await;
            if let Some(session_token) = cfg.pair(pairing_token, client_name) {
                let _ = cfg.save(&config_path);
                let server_name = cfg.server.name.clone();
                drop(cfg);

                let resp = serde_json::json!({
                    "id": id,
                    "result": {
                        "session_token": session_token,
                        "server_name": server_name
                    }
                });
                send_message(&writer, &resp).await;
                authenticated = true;
                break;
            }
            drop(cfg);
        }

        auth_attempts += 1;
        let err = serde_json::json!({
            "id": id,
            "error": {
                "code": -2,
                "message": format!(
                    "Authentication failed ({}/{})",
                    auth_attempts, max_attempts
                )
            }
        });
        send_message(&writer, &err).await;
    }

    if !authenticated {
        eprintln!(
            "[ws] Auth failed after {max_attempts} attempts from {addr}, dropping connection"
        );
        return;
    }

    println!("[ws] Authenticated connection from {addr}");

    // Phase 2: Command loop.
    while let Some(msg_result) = read.next().await {
        let text = match msg_result {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => {
                println!("[ws] Connection closed from {addr}");
                break;
            }
            Ok(Message::Ping(data)) => {
                let mut w = writer.lock().await;
                let _ = w.send(Message::Pong(data)).await;
                continue;
            }
            Err(e) => {
                eprintln!("[ws] Error from {addr}: {e}");
                break;
            }
            _ => continue,
        };

        let request: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                let err = serde_json::json!({
                    "id": null,
                    "error": {"code": -32700, "message": format!("Parse error: {e}")}
                });
                send_message(&writer, &err).await;
                continue;
            }
        };

        let state = std::sync::Arc::clone(&state);
        let writer = std::sync::Arc::clone(&writer);
        tokio::spawn(async move {
            let response = handler::handle_request(&state, &writer, &request).await;
            send_message(&writer, &response).await;
        });
    }

    println!("[ws] Disconnected: {addr}");
}
