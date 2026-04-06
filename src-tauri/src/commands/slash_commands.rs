use std::path::PathBuf;

use claudette::slash_commands::{self, SlashCommand};

#[tauri::command]
pub async fn list_slash_commands(
    project_path: Option<String>,
) -> Result<Vec<SlashCommand>, String> {
    let path = project_path.map(PathBuf::from);
    Ok(slash_commands::discover_slash_commands(path.as_deref()))
}
