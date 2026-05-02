use std::collections::HashMap;
use std::io::Write as IoWrite;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use claudette::env_provider::EnvCache;
use claudette::env_provider::types::EnvMap;
use claudette::plugin_runtime::PluginRegistry;
use claudette::room::RoomRegistry;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::auth::{ServerConfig, participant_id_for_token};
use crate::handler::{self, ConnectionCtx};

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
    /// Registry of collaborative-session rooms. Shared with the embedding
    /// Tauri process so a publish from either side reaches subscribers on
    /// the other. Solo / 1:1 sessions never enter the registry; bridge code
    /// falls back to the direct-write path when no room exists.
    pub rooms: Arc<RoomRegistry>,
    /// The live `ServerConfig`. Held here (not just locally in
    /// `handle_tls_connection`) so RPC handlers can re-check that the
    /// connection's parent share still exists on every request — that's
    /// how we get immediate revocation when the host calls `stop_share`.
    /// Wrapped in an async `Mutex` because mutations happen from both the
    /// auth path and the share-management commands.
    pub config: Arc<AsyncMutex<ServerConfig>>,
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
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf, config: ServerConfig) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            plugins: None,
            env_cache: Arc::new(EnvCache::new()),
            rooms: RoomRegistry::new(),
            config: Arc::new(AsyncMutex::new(config)),
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
        config: ServerConfig,
    ) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            plugins: Some(RwLock::new(plugins)),
            env_cache: Arc::new(EnvCache::new()),
            rooms: RoomRegistry::new(),
            config: Arc::new(AsyncMutex::new(config)),
        }
    }

    /// Construct a `ServerState` with both a plugin registry and an
    /// externally-owned `RoomRegistry`. The Tauri host shares its own
    /// registry so collab events fan out across both processes.
    pub fn new_with_plugins_and_rooms(
        db_path: PathBuf,
        worktree_base_dir: PathBuf,
        plugins: PluginRegistry,
        rooms: Arc<RoomRegistry>,
        config: ServerConfig,
    ) -> Self {
        Self::new_with_plugins_rooms_and_config_arc(
            db_path,
            worktree_base_dir,
            plugins,
            rooms,
            Arc::new(AsyncMutex::new(config)),
        )
    }

    /// Construct from an already-shared `Arc<Mutex<ServerConfig>>`. Used
    /// when the Tauri host wants to share both the room registry AND the
    /// config (so it can mint and revoke shares while the in-process
    /// server is running).
    pub fn new_with_plugins_rooms_and_config_arc(
        db_path: PathBuf,
        worktree_base_dir: PathBuf,
        plugins: PluginRegistry,
        rooms: Arc<RoomRegistry>,
        config: Arc<AsyncMutex<ServerConfig>>,
    ) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            plugins: Some(RwLock::new(plugins)),
            env_cache: Arc::new(EnvCache::new()),
            rooms,
            config,
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
    // Captured after successful auth and used to construct the per-request
    // `ConnectionCtx`. All stay `None` until auth succeeds.
    let mut auth_participant_id: Option<String> = None;
    let mut auth_display_name: Option<String> = None;
    let mut auth_share_id: Option<String> = None;
    let mut auth_allowed_workspaces: Option<Vec<String>> = None;
    let mut auth_collaborative: bool = false;
    let mut auth_consensus_required: bool = false;

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
            if let Some(resolved) = cfg.validate_session(session_token) {
                let _ = cfg.save(&config_path);
                let server_name = cfg.server.name.clone();
                drop(cfg);

                let participant_id = participant_id_for_token(session_token);
                auth_participant_id = Some(participant_id.clone());
                auth_display_name = Some(resolved.session.name.clone());
                auth_share_id = Some(resolved.share_id.clone());
                auth_allowed_workspaces = Some(resolved.allowed_workspace_ids.clone());
                auth_collaborative = resolved.collaborative;
                auth_consensus_required = resolved.consensus_required;

                // `participant_id` lets the client label its own messages
                // ("You" vs "Alice") in collaborative sessions. Hashed from
                // the session token, so it leaks nothing the client doesn't
                // already hold.
                let resp = serde_json::json!({
                    "id": id,
                    "result": {
                        "server_name": server_name,
                        "participant_id": participant_id,
                        "allowed_workspace_ids": resolved.allowed_workspace_ids,
                        "collaborative": resolved.collaborative,
                        "consensus_required": resolved.consensus_required,
                    }
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
            if let Some(resolved) = cfg.pair(pairing_token, client_name) {
                let _ = cfg.save(&config_path);
                let server_name = cfg.server.name.clone();
                drop(cfg);

                let session_token = resolved.session.token.clone();
                let participant_id = participant_id_for_token(&session_token);
                auth_participant_id = Some(participant_id.clone());
                auth_display_name = Some(client_name.to_string());
                auth_share_id = Some(resolved.share_id.clone());
                auth_allowed_workspaces = Some(resolved.allowed_workspace_ids.clone());
                auth_collaborative = resolved.collaborative;
                auth_consensus_required = resolved.consensus_required;

                let resp = serde_json::json!({
                    "id": id,
                    "result": {
                        "session_token": session_token,
                        "server_name": server_name,
                        "participant_id": participant_id,
                        "allowed_workspace_ids": resolved.allowed_workspace_ids,
                        "collaborative": resolved.collaborative,
                        "consensus_required": resolved.consensus_required,
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

    // SAFETY: every successful auth path above populates all four fields
    // before `authenticated = true`; the `if !authenticated { return; }`
    // gate ensures we only reach this point after one of those branches ran.
    let ctx = ConnectionCtx::from_session(
        auth_participant_id.expect("participant id set on successful auth"),
        auth_display_name.expect("display name set on successful auth"),
        auth_share_id.expect("share id set on successful auth"),
        auth_allowed_workspaces.expect("allowed workspaces set on successful auth"),
        auth_collaborative,
        auth_consensus_required,
    );

    println!(
        "[ws] Authenticated connection from {addr} as {} ({})",
        ctx.display_name,
        ctx.participant_id.as_str()
    );

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

        let state_for_dispatch = std::sync::Arc::clone(&state);
        let writer = std::sync::Arc::clone(&writer);
        let ctx_for_dispatch = ctx.clone();
        tokio::spawn(async move {
            let response =
                handler::handle_request(&state_for_dispatch, &writer, &ctx_for_dispatch, &request)
                    .await;
            send_message(&writer, &response).await;
        });
    }

    // Connection ended — drop the participant from any rooms they were in
    // so other participants see them leave promptly. Without this, a
    // ghosted voter could hold up plan consensus for the rest of the room.
    crate::collab::drop_all_joined_sessions(&state, &ctx).await;
    println!("[ws] Disconnected: {addr}");
}
