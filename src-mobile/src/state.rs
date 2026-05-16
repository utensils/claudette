//! Mobile-side connection registry. Holds the active `Transport` for each
//! paired server so the webview can issue RPC calls without re-establishing
//! the WSS connection on every invoke. Tiny by design — the heavy lifting
//! lives in `claudette::transport::ws::WebSocketTransport`.

use std::collections::HashMap;
use std::sync::Arc;

use claudette::transport::Transport;
use tokio::sync::RwLock;

/// One live remote connection on the phone — either to a desktop GUI's
/// embedded server or to a standalone `claudette-server`.
#[derive(Clone)]
pub struct Connection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub server_name: String,
    pub fingerprint: String,
    pub transport: Arc<dyn Transport>,
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
