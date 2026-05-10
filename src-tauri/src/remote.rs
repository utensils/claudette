use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::transport::Transport;
use crate::transport::ws::WebSocketTransport;

/// Persisted remote connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteConnectionInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub session_token: Option<String>,
    pub cert_fingerprint: Option<String>,
    pub auto_connect: bool,
    pub created_at: String,
    /// Stable id for the local user as seen by the remote server. Derived
    /// (not persisted) — recomputed from `session_token` at every construction
    /// site so we don't need a DB migration. The frontend uses this to detect
    /// "this message is mine" in collaborative sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_id: Option<String>,
}

/// Derive a frontend-visible participant id from a stored session token.
/// Calls into `claudette-server` so the algorithm matches the server side
/// (which is what the room/collab protocol uses to key participants).
#[cfg(feature = "server")]
pub fn participant_id_for(session_token: Option<&str>) -> Option<String> {
    session_token.map(claudette_server::auth::participant_id_for_token)
}

#[cfg(not(feature = "server"))]
pub fn participant_id_for(_session_token: Option<&str>) -> Option<String> {
    None
}

/// An active connection to a remote claudette-server.
pub struct RemoteConnection {
    pub info: RemoteConnectionInfo,
    pub transport: Arc<WebSocketTransport>,
    _event_task: tokio::task::JoinHandle<()>,
}

/// Manages all active remote connections.
pub struct RemoteConnectionManager {
    pub connections: RwLock<Vec<RemoteConnection>>,
}

impl RemoteConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: RwLock::new(Vec::new()),
        }
    }

    /// Add an active connection and start forwarding its events to the Tauri event bus.
    /// If a connection with the same ID already exists, it is closed and replaced.
    pub async fn add(
        &self,
        info: RemoteConnectionInfo,
        transport: WebSocketTransport,
        app: AppHandle,
    ) {
        // Close and remove any existing connection with the same ID.
        let mut connections = self.connections.write().await;
        if let Some(idx) = connections.iter().position(|c| c.info.id == info.id) {
            let old = connections.remove(idx);
            let _ = old.transport.close().await;
        }

        let transport = Arc::new(transport);
        let mut event_rx = transport.event_stream();

        // Forward remote events to the Tauri event bus.
        // Events like "agent-stream" are emitted under their original name with the
        // original payload so the frontend handles them identically to local events.
        // Workspace IDs are UUIDs so there's no collision between local and remote.
        let connection_id = info.id.clone();
        let event_task = tokio::spawn(async move {
            loop {
                match event_rx.recv().await {
                    Ok(event) => {
                        let _ = app.emit(&event.event, &event.payload);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[remote] event channel lagged {n} messages, continuing");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            tracing::info!(target: "claudette::remote", connection_id = %connection_id, "event stream ended");
        });

        let conn = RemoteConnection {
            info,
            transport,
            _event_task: event_task,
        };

        connections.push(conn);
    }

    /// Send a JSON-RPC request to a specific remote connection.
    #[allow(dead_code)]
    pub async fn send(
        &self,
        connection_id: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let connections = self.connections.read().await;
        let conn = connections
            .iter()
            .find(|c| c.info.id == connection_id)
            .ok_or_else(|| format!("Remote connection {connection_id} not found"))?;
        conn.transport.send(request).await
    }

    /// Disconnect and remove a remote connection.
    pub async fn remove(&self, connection_id: &str) -> Result<(), String> {
        let mut connections = self.connections.write().await;
        if let Some(idx) = connections.iter().position(|c| c.info.id == connection_id) {
            let conn = connections.remove(idx);
            let _ = conn.transport.close().await;
        }
        Ok(())
    }

    /// List all active connection IDs.
    #[allow(dead_code)]
    pub async fn list_active(&self) -> Vec<RemoteConnectionInfo> {
        let connections = self.connections.read().await;
        connections.iter().map(|c| c.info.clone()).collect()
    }

    /// Check if a connection is active.
    #[allow(dead_code)]
    pub async fn is_connected(&self, connection_id: &str) -> bool {
        let connections = self.connections.read().await;
        connections
            .iter()
            .any(|c| c.info.id == connection_id && c.transport.is_connected())
    }
}

/// Server discovered via mDNS on the local network.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredServer {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub cert_fingerprint_prefix: String,
    pub is_paired: bool,
}
