use tauri::State;

use crate::state::AppState;
use crate::usage::{self, ClaudeCodeUsage};

#[tauri::command]
pub async fn get_claude_code_usage(state: State<'_, AppState>) -> Result<ClaudeCodeUsage, String> {
    usage::get_usage(&state.usage_cache).await
}

#[tauri::command]
pub async fn open_usage_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(target_os = "macos"))]
    let cmd = "xdg-open";

    tokio::process::Command::new(cmd)
        .arg("https://claude.ai/settings/usage")
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}
