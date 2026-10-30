use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{RwLock, broadcast};

use claudette::transport::Transport;
use claudette::transport::ws::WebSocketTransport;

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
        let event_rx = transport.event_stream();
        let closed_rx = transport.closed();
        let event_task = tokio::spawn(forward_remote_events(
            app,
            info.id.clone(),
            Arc::clone(&transport),
            event_rx,
            closed_rx,
        ));

        let conn = RemoteConnection {
            info,
            transport,
            _event_task: event_task,
        };

        connections.push(conn);
    }

    /// Send a JSON-RPC request to a specific remote connection.
    pub async fn send(
        &self,
        connection_id: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let connections = self.connections.read().await;
        let conn = connections
            .iter()
            .find(|c| c.info.id == connection_id)
            .ok_or_else(|| format!("Remote connection {connection_id} is not connected"))?;
        let transport = Arc::clone(&conn.transport);
        // Don't hold the read lock across the network round-trip — a slow
        // remote would otherwise block connect/disconnect for every server.
        drop(connections);
        transport.send(request).await
    }

    /// Like [`Self::send`], but unwraps the JSON-RPC envelope: returns the
    /// `result` value, or the server's `error.message` as `Err`.
    pub async fn call(
        &self,
        connection_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let response = self
            .send(
                connection_id,
                serde_json::json!({ "method": method, "params": params }),
            )
            .await?;
        rpc_result(response)
    }

    /// Drop `connection_id` only if it still refers to `transport`. A
    /// reconnect replaces the entry under the same ID, and the old
    /// connection's forwarder must not evict its replacement.
    /// Returns whether an entry was removed.
    async fn remove_if_same(
        &self,
        connection_id: &str,
        transport: &Arc<WebSocketTransport>,
    ) -> bool {
        let mut connections = self.connections.write().await;
        if let Some(idx) = connections
            .iter()
            .position(|c| c.info.id == connection_id && Arc::ptr_eq(&c.transport, transport))
        {
            connections.remove(idx);
            true
        } else {
            false
        }
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

/// Unwrap a JSON-RPC response envelope into `result` or the server's error
/// message. A response with neither is treated as a `null` result.
pub fn rpc_result(response: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(|m| m.as_str())
            .map(String::from)
            .unwrap_or_else(|| error.to_string()));
    }
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Event emitted on the local bus when a remote connection drops
/// unexpectedly (not on an explicit disconnect).
pub const REMOTE_CONNECTION_LOST_EVENT: &str = "remote-connection-lost";

/// Re-emit a remote server's events on the local Tauri bus until the
/// connection closes, then tell the frontend and drop the dead entry.
///
/// Events keep their original name and payload so the frontend handles
/// them exactly like local ones (workspace / session IDs are UUIDs, so
/// there's no collision). Object payloads are tagged with
/// `remote_connection_id`, which lets the frontend attribute them and lets
/// a local share-server avoid re-broadcasting events that came from
/// another machine.
async fn forward_remote_events(
    app: AppHandle,
    connection_id: String,
    transport: Arc<WebSocketTransport>,
    mut event_rx: broadcast::Receiver<claudette::transport::ServerEvent>,
    mut closed_rx: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            received = event_rx.recv() => match received {
                Ok(event) => {
                    let payload = tag_remote_payload(event.payload, &connection_id);
                    let _ = app.emit(&event.event, payload);
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        target: "claudette::remote",
                        connection_id = %connection_id,
                        skipped,
                        "remote event forwarder lagged; events dropped"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            changed = closed_rx.changed() => {
                if changed.is_err() || *closed_rx.borrow() {
                    break;
                }
            }
        }
    }
    tracing::info!(target: "claudette::remote", connection_id = %connection_id, "event stream ended");

    // An explicit disconnect / replacement removes the entry before
    // closing the socket, so only an unexpected drop finds it still here.
    let manager = app.state::<RemoteConnectionManager>();
    if manager.remove_if_same(&connection_id, &transport).await {
        let _ = app.emit(
            REMOTE_CONNECTION_LOST_EVENT,
            serde_json::json!({ "connection_id": connection_id }),
        );
    }
}

fn tag_remote_payload(mut payload: serde_json::Value, connection_id: &str) -> serde_json::Value {
    if let Some(obj) = payload.as_object_mut() {
        obj.entry("remote_connection_id")
            .or_insert_with(|| serde_json::Value::String(connection_id.to_string()));
    }
    payload
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rpc_result_returns_result_value() {
        assert_eq!(
            rpc_result(json!({"id": 1, "result": {"ok": true}})).unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn rpc_result_surfaces_server_error_message() {
        let err =
            rpc_result(json!({"id": 1, "error": {"code": -1, "message": "Unknown method: x"}}))
                .unwrap_err();
        assert_eq!(err, "Unknown method: x");
    }

    #[test]
    fn rpc_result_missing_result_is_null() {
        assert_eq!(
            rpc_result(json!({"id": 1})).unwrap(),
            serde_json::Value::Null
        );
    }

    #[test]
    fn tag_remote_payload_adds_connection_id_to_objects_only() {
        assert_eq!(
            tag_remote_payload(json!({"a": 1}), "c1"),
            json!({"a": 1, "remote_connection_id": "c1"})
        );
        assert_eq!(tag_remote_payload(json!("x"), "c1"), json!("x"));
    }
}
