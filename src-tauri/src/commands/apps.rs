mod config;
mod detection;
mod launch;
mod model;
mod platform;

#[cfg(test)]
mod tests;

use tauri::State;

use crate::state::AppState;

use config::load_apps_config;
use detection::detect_from_config;
pub(crate) use launch::open_workspace_in_app_inner;
#[allow(unused_imports)]
pub use model::{AppCategory, AppEntry, AppsConfig, DetectedApp};
pub(crate) use model::{DEFAULT_TERMINAL_APP_SETTING_KEY, select_workspace_terminal_app_id};

#[tauri::command]
pub async fn detect_installed_apps(state: State<'_, AppState>) -> Result<Vec<DetectedApp>, String> {
    let apps = tokio::task::spawn_blocking(|| {
        let config = load_apps_config();
        detect_from_config(&config)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Cache for TUI editor terminal wrapping in open_workspace_in_app.
    *state.detected_apps.write().await = apps.clone();
    Ok(apps)
}

#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    open_workspace_in_app_inner(&app_id, &worktree_path, state.inner()).await
}
