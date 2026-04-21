use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[allow(dead_code)]
pub enum AgentStatus {
    Running,
    Idle,
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

impl std::str::FromStr for WorkspaceStatus {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "archived" => Self::Archived,
            _ => Self::Active,
        })
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
}
