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
    pub async fn add(
        &self,
        info: RemoteConnectionInfo,
        transport: WebSocketTransport,
        app: AppHandle,
    ) {
        let transport = Arc::new(transport);
        let mut event_rx = transport.event_stream();

        // Forward remote events to Tauri event bus, prefixed with "remote:".
        let connection_id = info.id.clone();
        let event_task = tokio::spawn(async move {
            while let Ok(event) = event_rx.recv().await {
                // Forward as-is — the frontend distinguishes remote events by
                // the presence of remote_connection_id on the workspace.
                let _ = app.emit(&event.event, &event.payload);
            }
            eprintln!("[remote] Event stream ended for connection {connection_id}");
        });

        let conn = RemoteConnection {
            info,
            transport,
            _event_task: event_task,
        };

        let mut connections = self.connections.write().await;
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
