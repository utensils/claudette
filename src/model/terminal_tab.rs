use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalTabKind {
    #[default]
    Pty,
    AgentTask,
}

/// Metadata for a terminal tab. The actual PTY process state is
/// ephemeral and managed by the Tauri backend.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TerminalTab {
    pub id: i64,
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub kind: TerminalTabKind,
    pub is_script_output: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub agent_chat_session_id: Option<String>,
    pub agent_tool_use_id: Option<String>,
    pub agent_task_id: Option<String>,
    pub output_path: Option<String>,
    pub task_status: Option<String>,
    pub task_summary: Option<String>,
}
