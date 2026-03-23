/// Metadata for a terminal tab. The actual terminal emulator state
/// (iced_term::Terminal, PTY process) is ephemeral and stored on App.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TerminalTab {
    pub id: i64,
    pub workspace_id: String,
    pub title: String,
    pub is_script_output: bool,
    pub sort_order: i32,
    pub created_at: String,
}
