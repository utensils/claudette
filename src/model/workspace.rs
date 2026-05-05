use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[allow(dead_code)]
pub enum AgentStatus {
    Running,
    Idle,
    IdleWithBackground,
    Stopped,
    /// Set while the CLI is context-compacting (~90s). Visually treated
    /// like Running (spinner + disabled input) but with a distinct label.
    Compacting,
    Error(String),
}

impl AgentStatus {
    pub fn label(&self) -> &str {
        match self {
            Self::Running => "Running",
            Self::Idle => "Idle",
            Self::IdleWithBackground => "IdleWithBackground",
            Self::Stopped => "Stopped",
            Self::Compacting => "Compacting",
            Self::Error(_) => "Error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum WorkspaceStatus {
    Active,
    Archived,
}

impl WorkspaceStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

/// Returned when a string doesn't correspond to any known [`WorkspaceStatus`].
/// Surfacing the unknown value (instead of silently coercing) lets callers
/// detect corrupted DB rows or values written by a forward-version of the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseWorkspaceStatusError(pub String);

impl std::fmt::Display for ParseWorkspaceStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown WorkspaceStatus value: {:?}", self.0)
    }
}

impl std::error::Error for ParseWorkspaceStatusError {}

impl std::str::FromStr for WorkspaceStatus {
    type Err = ParseWorkspaceStatusError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            other => Err(ParseWorkspaceStatusError(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct Workspace {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub branch_name: String,
    pub worktree_path: Option<String>,
    pub status: WorkspaceStatus,
    pub agent_status: AgentStatus,
    pub status_line: String,
    pub created_at: String,
    /// Per-repository display order for the sidebar. Persisted via the
    /// `workspaces.sort_order` column; reassigned by `reorder_workspaces`.
    pub sort_order: i32,
}
