use tauri::State;

use crate::state::AppState;
use crate::usage::{self, ClaudeCodeUsage};
use claudette::process::CommandWindowExt as _;

#[tauri::command]
pub async fn get_claude_code_usage(state: State<'_, AppState>) -> Result<ClaudeCodeUsage, String> {
    usage::get_usage(&state.usage_cache).await
}

#[tauri::command]
pub async fn open_usage_settings() -> Result<(), String> {
    open_external_url("https://claude.ai/settings/usage").await
}

#[tauri::command]
pub async fn open_release_notes() -> Result<(), String> {
    open_external_url("https://github.com/utensils/Claudette/releases").await
}

async fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open").no_console_window()
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("cmd").no_console_window()
            .args(["/C", "start", url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        tokio::process::Command::new("xdg-open").no_console_window()
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }

    Ok(())
}
