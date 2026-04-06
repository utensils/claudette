use std::collections::HashMap;
use std::io::Write as IoWrite;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

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
}

pub struct AgentSessionState {
    pub session_id: String,
    pub turn_count: u32,
    pub active_pid: Option<u32>,
    pub custom_instructions: Option<String>,
}

pub struct PtyHandle {
    pub writer: Mutex<Box<dyn IoWrite + Send>>,
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

impl ServerState {
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
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
    mut config: ServerConfig,
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
        if let Some(session_token) = params.get("session_token").and_then(|t| t.as_str())
            && config.validate_session(session_token)
        {
            // Persist last_seen update.
            let config_path = dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("claudette-server")
                .join("server.toml");
            let _ = config.save(&config_path);

            let resp = serde_json::json!({
                "id": id,
                "result": {"server_name": config.server.name}
            });
            send_message(&writer, &resp).await;
            authenticated = true;
            break;
        }

        if let Some(pairing_token) = params.get("pairing_token").and_then(|t| t.as_str()) {
            let client_name = params
                .get("client_name")
                .and_then(|n| n.as_str())
                .unwrap_or("Unknown client");

            if let Some(session_token) = config.pair(pairing_token, client_name) {
                // Persist the new session.
                let config_path = dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("claudette-server")
                    .join("server.toml");
                let _ = config.save(&config_path);

                let resp = serde_json::json!({
                    "id": id,
                    "result": {
                        "session_token": session_token,
                        "server_name": config.server.name
                    }
                });
                send_message(&writer, &resp).await;
                authenticated = true;
                break;
            }
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
