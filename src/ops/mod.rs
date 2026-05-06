//! Shared command core used by every public surface of Claudette.
//!
//! Tauri commands (GUI), the WebSocket JSON-RPC handler (`claudette-server`),
//! the upcoming local-IPC handler used by the `claudette` CLI, and the CLI
//! itself in remote-driven scenarios all dispatch into this module so a single
//! implementation owns each operation.
//!
//! The pattern: each op is `(db, hooks, params) -> Result<output, OpsError>`,
//! pure with respect to the caller's process state. UI-side effects (tray
//! rebuild, notification sound, frontend events) flow through the [`OpsHooks`]
//! trait so the GUI fires real notifications, the WS server fires nothing
//! (until we wire it up), and the CLI inherits the GUI's behavior because it
//! invokes the GUI's own hook implementation over IPC.

pub mod workspace;

use std::fmt;

/// Errors returned by ops. Each variant carries enough context for the caller
/// to render a useful message — callers convert to their own error shape
/// (`String` for Tauri commands and JSON-RPC, `anyhow::Error` for tests).
#[derive(Debug)]
pub enum OpsError {
    /// A required entity (repository, workspace, chat session) was not found.
    NotFound(String),
    /// User input failed validation (workspace name, branch prefix, etc.).
    Validation(String),
    /// A git subprocess returned an error.
    Git(crate::git::GitError),
    /// A SQLite query failed.
    Db(rusqlite::Error),
    /// A repository-level invariant was violated (e.g. uncommitted state
    /// blocking worktree creation, no commits in repo).
    Repo(String),
    /// Catch-all for unexpected errors that don't fit the categories above.
    Other(String),
}

impl fmt::Display for OpsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(msg) => write!(f, "{msg}"),
            Self::Validation(msg) => write!(f, "{msg}"),
            Self::Git(err) => write!(f, "{err}"),
            Self::Db(err) => write!(f, "{err}"),
            Self::Repo(msg) => write!(f, "{msg}"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for OpsError {}

impl From<crate::git::GitError> for OpsError {
    fn from(err: crate::git::GitError) -> Self {
        Self::Git(err)
    }
}

impl From<rusqlite::Error> for OpsError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err)
    }
}

/// Why a workspace's lifecycle row changed. Hooks use this to decide what
/// to refresh — e.g. tray rebuild on Created/Archived/Restored/Deleted, but
/// not on a no-op rename in the same repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceChangeKind {
    Created,
    Archived,
    Restored,
    Deleted,
    Renamed,
}

/// Notification events that ops fire through [`OpsHooks::notification`].
/// Mirrors the GUI's own `tray::NotificationEvent` so the lib stays free of
/// any tauri-specific types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationEvent {
    Ask,
    Plan,
    Finished,
    Error,
    SessionStart,
}

/// Side-effect surface implemented by each caller of the ops layer.
///
/// All methods default to no-ops so callers that don't care (the WS server
/// today, unit tests, the CLI in remote mode) can use [`NoopHooks`] without
/// implementing anything. The GUI implements the hooks to rebuild its tray
/// and play notification sounds; the local-IPC path forwards them through
/// the same GUI-side implementation so CLI-driven actions trigger identical
/// UI feedback.
pub trait OpsHooks: Send + Sync {
    fn workspace_changed(&self, _workspace_id: &str, _kind: WorkspaceChangeKind) {}
    fn notification(&self, _event: NotificationEvent) {}
}

/// No-op hook impl — used by the WS server and unit tests. Implements
/// [`OpsHooks`] with all methods left at their default no-op behavior.
pub struct NoopHooks;

impl OpsHooks for NoopHooks {}
