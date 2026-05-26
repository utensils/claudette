pub mod ws;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// A server-pushed event received over the transport.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

/// Transport-agnostic connection to a remote claudette-server.
#[allow(dead_code)]
#[async_trait::async_trait]
pub trait Transport: Send + Sync + 'static {
    /// Send a JSON-RPC request and return the response.
    async fn send(&self, request: serde_json::Value) -> Result<serde_json::Value, String>;

    /// Subscribe to unsolicited events from the remote.
    fn event_stream(&self) -> broadcast::Receiver<ServerEvent>;

    /// Cleanly shut down the transport.
    async fn close(&self) -> Result<(), String>;

    /// Check whether the transport is still alive.
    fn is_connected(&self) -> bool;
}
