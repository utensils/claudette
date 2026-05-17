//! Detachable host abstraction for interactive `claude` sessions.

pub mod availability;
pub mod conformance;
pub mod sidecar;
#[cfg(unix)]
pub mod tmux;
pub mod types;

pub use crate::agent::interactive_protocol::{HookFired, InputPayload, SessionSpec, StopMode};
pub use types::{
    AttachEvent, AttachId, HostHandle, HostSessionSummary, HostStatus, ScreenSnapshot, SessionId,
};

use async_trait::async_trait;
use std::pin::Pin;
use tokio_stream::Stream;

/// Type alias for the live attach stream.
pub type AttachStream = Pin<Box<dyn Stream<Item = AttachEvent> + Send + 'static>>;

#[async_trait]
pub trait InteractiveHost: Send + Sync {
    async fn ensure_session(
        &self,
        sid: &SessionId,
        spec: &SessionSpec,
    ) -> Result<HostHandle, HostError>;
    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError>;
    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError>;
    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError>;
    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError>;
    async fn detach(&self, sid: &SessionId, attach_id: AttachId) -> Result<(), HostError>;
    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError>;
    async fn status(&self) -> Result<HostStatus, HostError>;
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("host unavailable: {0}")]
    Unavailable(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("other: {0}")]
    Other(String),
}

/// Pick the default `InteractiveHost` for the current platform.
///
/// On Unix, prefers a tmux-backed host when `tmux >= 3.0` is on `PATH` and
/// the caller hasn't asked for the sidecar explicitly (`prefer_sidecar_on_unix
/// = false`). On Windows, or when tmux is missing / too old, falls back to
/// the sidecar host backed by `sidecar_binary` over `sidecar_socket`.
pub async fn select_default_host(
    runtime_dir: &std::path::Path,
    sidecar_socket: &std::path::Path,
    sidecar_binary: &std::path::Path,
    prefer_sidecar_on_unix: bool,
) -> Result<std::sync::Arc<dyn InteractiveHost>, HostError> {
    // Silence unused-arg warnings on Windows, where the tmux path is
    // unreachable. The sidecar branch consumes the other two.
    #[cfg(not(unix))]
    let _ = (runtime_dir, prefer_sidecar_on_unix);

    #[cfg(unix)]
    if !prefer_sidecar_on_unix
        && matches!(
            availability::check_tmux().await,
            availability::TmuxAvailability::Available { .. }
        )
    {
        return Ok(std::sync::Arc::new(tmux::TmuxHost::new(
            runtime_dir.to_path_buf(),
        )));
    }

    Ok(std::sync::Arc::new(sidecar::SidecarHost::new(
        sidecar_socket.to_path_buf(),
        sidecar_binary.to_path_buf(),
    )))
}
