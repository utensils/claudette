use serde::Serialize;

/// Metadata for a terminal tab. The actual PTY process state is
/// ephemeral and managed by the Tauri backend.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct TerminalTab {
    pub id: i64,
    pub workspace_id: String,
    pub title: String,
    pub is_script_output: bool,
    pub sort_order: i32,
    pub created_at: String,
}
