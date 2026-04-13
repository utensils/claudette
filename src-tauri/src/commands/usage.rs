use tauri::State;

use crate::state::AppState;
use crate::usage::{self, ClaudeCodeUsage};

#[tauri::command]
pub async fn get_claude_code_usage(state: State<'_, AppState>) -> Result<ClaudeCodeUsage, String> {
    usage::get_usage(&state.usage_cache).await
}

#[tauri::command]
pub async fn open_usage_settings() -> Result<(), String> {
    let url = "https://claude.ai/settings/usage";

    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("cmd")
            .args(["/C", "start", url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        tokio::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }

    Ok(())
}
