use serde::Serialize;

use crate::model::workspace::AgentStatus;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum SessionStatus {
    Active,
    Archived,
}

impl SessionStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

impl std::str::FromStr for SessionStatus {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "archived" => Self::Archived,
            _ => Self::Active,
        })
    }
}

/// Kind of input the agent is waiting for. Mirrors `AttentionKind` in
/// `src-tauri/src/state.rs` but as an owned string so the lib crate stays
/// free of Tauri deps.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum AttentionKind {
    Ask,
    Plan,
}

impl AttentionKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ask => "ask",
            Self::Plan => "plan",
        }
    }
}

/// A conversation within a workspace. Each session has its own Claude CLI
/// subprocess, its own message history, and its own checkpoint timeline.
/// A workspace always has at least one active session.
#[derive(Debug, Clone, Serialize)]
pub struct ChatSession {
    pub id: String,
    pub workspace_id: String,
    /// Claude CLI `--resume` UUID. `None` until the first turn completes.
    pub claude_session_id: Option<String>,
    pub name: String,
    /// `true` once the user renames the session — Haiku auto-naming never
    /// overwrites a user-edited name.
    pub name_edited: bool,
    pub turn_count: u32,
    pub sort_order: i32,
    pub status: SessionStatus,
    pub created_at: String,
    pub archived_at: Option<String>,
    /// Runtime agent status — defaults to `Idle` when loaded from DB; the
    /// command layer overlays the live `AppState.agents` view on top.
    pub agent_status: AgentStatus,
    /// Runtime attention flag — defaults to `false` from DB.
    pub needs_attention: bool,
    /// Runtime attention kind — defaults to `None` from DB.
    pub attention_kind: Option<AttentionKind>,
}
