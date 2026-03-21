#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum AgentStatus {
    Running,
    Idle,
    Stopped,
}

impl AgentStatus {
    pub fn label(&self) -> &str {
        match self {
            Self::Running => "Running",
            Self::Idle => "Idle",
            Self::Stopped => "Stopped",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
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

    pub fn from_str(s: &str) -> Self {
        match s {
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone)]
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
