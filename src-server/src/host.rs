//! The seam between the WSS transport and whatever actually serves requests.
//!
//! The standalone `claudette-server` binary serves requests from its own
//! [`ServerState`] via [`crate::handler`]. The desktop app's "Share this
//! machine" runs the same transport in-process but implements [`RpcHost`]
//! on top of its own command core, so remote clients drive exactly the same
//! agent sessions the local window shows.

use std::sync::Arc;

use tokio::sync::broadcast;

use crate::ws::ServerState;

/// Serves JSON-RPC requests and publishes server-pushed events for the WSS
/// transport.
#[async_trait::async_trait]
pub trait RpcHost: Send + Sync + 'static {
    /// Handle one request. `Err` becomes a JSON-RPC error response.
    async fn dispatch(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String>;

    /// Subscribe to `{"event", "payload"}` envelopes to push to a client.
    fn subscribe(&self) -> broadcast::Receiver<serde_json::Value>;
}

/// [`RpcHost`] backed by the server's own state and handlers.
pub struct StandaloneHost {
    pub state: Arc<ServerState>,
}

#[async_trait::async_trait]
impl RpcHost for StandaloneHost {
    async fn dispatch(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        crate::handler::dispatch(&self.state, method, params).await
    }

    fn subscribe(&self) -> broadcast::Receiver<serde_json::Value> {
        self.state.events.subscribe()
    }
}
