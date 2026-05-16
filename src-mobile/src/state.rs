//! Mobile-side connection registry. Holds the active `Transport` for each
//! paired server so the webview can issue RPC calls without re-establishing
//! the WSS connection on every invoke. Tiny by design — the heavy lifting
//! lives in `claudette::transport::ws::WebSocketTransport`.

use std::collections::HashMap;
use std::sync::Arc;

use claudette::transport::Transport;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

/// One live remote connection on the phone — either to a desktop GUI's
/// embedded server or to a standalone `claudette-server`. The
/// `event_forwarder` field holds a background task that consumes the
/// transport's broadcast stream and re-emits each `ServerEvent` to the
/// webview via `app_handle.emit`. Cancelled on drop so reconnecting
/// doesn't leak duplicate forwarders.
pub struct Connection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub server_name: String,
    pub fingerprint: String,
    pub transport: Arc<dyn Transport>,
    pub event_forwarder: Option<JoinHandle<()>>,
}

impl Clone for Connection {
    fn clone(&self) -> Self {
        // The event-forwarder task is owned by the registry entry; clones
        // (handed out to RPC commands) don't take a join handle. Only the
        // canonical entry in `ConnectionManager` keeps `event_forwarder`
        // populated, and removing that entry aborts the task.
        Self {
            id: self.id.clone(),
            host: self.host.clone(),
            port: self.port,
            server_name: self.server_name.clone(),
            fingerprint: self.fingerprint.clone(),
            transport: Arc::clone(&self.transport),
            event_forwarder: None,
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(handle) = self.event_forwarder.take() {
            handle.abort();
        }
    }
}

/// Registry of currently-open connections, keyed by an opaque connection
/// id the mobile app generates on first pair. Wrapped in `RwLock` because
/// the event-forwarding tasks added in Phase 7 will read this concurrently
/// with the webview's `send_rpc` calls.
#[derive(Default)]
pub struct ConnectionManager {
    inner: RwLock<HashMap<String, Connection>>,
}

impl ConnectionManager {
    pub async fn insert(&self, conn: Connection) {
        let mut map = self.inner.write().await;
        map.insert(conn.id.clone(), conn);
    }

    pub async fn get(&self, id: &str) -> Option<Connection> {
        let map = self.inner.read().await;
        map.get(id).cloned()
    }

    pub async fn remove(&self, id: &str) -> Option<Connection> {
        let mut map = self.inner.write().await;
        map.remove(id)
    }

    pub async fn list(&self) -> Vec<Connection> {
        let map = self.inner.read().await;
        map.values().cloned().collect()
    }
}
