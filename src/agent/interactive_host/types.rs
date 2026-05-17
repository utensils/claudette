//! Shared types used by both InteractiveHost implementations.

use serde::{Deserialize, Serialize};

pub use crate::agent::interactive_protocol::{HookFired, InputPayload, SessionSpec, StopMode};

/// Stable identifier for an interactive session.
///
/// Format: `claudette-<workspace_id_short>-<sid8>`. Identical between tmux and
/// sidecar so a single string identifies the session in any host.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new(workspace_short: &str, sid8: &str) -> Self {
        Self(format!("claudette-{workspace_short}-{sid8}"))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Returned from `ensure_session`.
#[derive(Debug, Clone)]
pub struct HostHandle {
    pub sid: SessionId,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
}

/// Identifies a single attach subscription. Multiple attaches per session are
/// allowed; detach uses the attach_id to drop the right one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AttachId(pub u64);

/// Event yielded by an `AttachStream`.
#[derive(Debug, Clone)]
pub enum AttachEvent {
    Output { bytes: Vec<u8>, seq: u64 },
    Hook(HookFired),
    Exit { exit_status: i32, reason: String },
    Error { message: String, recoverable: bool },
}

/// Snapshot of the current screen for instant repaint on reattach.
#[derive(Debug, Clone)]
pub struct ScreenSnapshot {
    pub rows: u16,
    pub cols: u16,
    pub ansi_bytes: Vec<u8>,
}

/// Host enumeration entry.
#[derive(Debug, Clone)]
pub struct HostSessionSummary {
    pub sid: SessionId,
    pub pid: Option<u32>,
    pub running: bool,
}

#[derive(Debug, Clone)]
pub struct HostStatus {
    pub host_version: String,
    pub sessions: Vec<HostSessionSummary>,
}
