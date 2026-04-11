use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use claudette::db::Database;

use crate::state::AppState;

#[derive(Serialize, Deserialize)]
pub struct ThemeDefinition {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub colors: HashMap<String, String>,
}

#[tauri::command]
pub async fn get_app_setting(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.get_app_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_app_setting(
    key: String,
    value: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_app_setting(&key, &value)
        .map_err(|e| e.to_string())?;

    // If updating worktree base dir, also update in-memory state.
    if key == "worktree_base_dir" {
        let mut dir = state.worktree_base_dir.write().await;
        *dir = std::path::PathBuf::from(&value);
    }

    // Toggle system tray on/off.
    if key == "tray_enabled" {
        if value == "true" {
            if let Err(e) = crate::tray::setup_tray(&app) {
                // Revert the setting so the UI doesn't show an enabled tray
                // that never actually appeared (e.g., missing appindicator on Linux).
                let _ = db.set_app_setting("tray_enabled", "false");
                return Err(format!("Failed to enable tray: {e}"));
            }
        } else {
            crate::tray::destroy_tray(&app);
        }
    }

    // Rebuild tray when active-only filter changes.
    if key == "tray_active_only" {
        crate::tray::rebuild_tray(&app);
    }

    Ok(())
}

#[tauri::command]
pub async fn list_user_themes() -> Result<Vec<ThemeDefinition>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let themes_dir = dirs::home_dir()
            .ok_or("Could not determine home directory")?
            .join(".claudette")
            .join("themes");

        if !themes_dir.exists() {
            return Ok(Vec::new());
        }

        let mut themes = Vec::new();
        let entries = std::fs::read_dir(&themes_dir).map_err(|e| e.to_string())?;
        const MAX_THEME_FILE_BYTES: u64 = 1024 * 1024;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[themes] Skipping unreadable directory entry: {e}");
                    continue;
                }
            };

            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }

            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > MAX_THEME_FILE_BYTES => {
                    eprintln!(
                        "[themes] Skipping {}: file too large ({} bytes)",
                        path.display(),
                        meta.len()
                    );
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[themes] Skipping {}: {e}", path.display());
                    continue;
                }
            }

            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[themes] Skipping {}: {e}", path.display());
                    continue;
                }
            };

            match serde_json::from_str::<ThemeDefinition>(&content) {
                Ok(theme) => themes.push(theme),
                Err(e) => eprintln!("[themes] Skipping {}: {e}", path.display()),
            }
        }

        Ok(themes)
    })
    .await
    .map_err(|e| e.to_string())?
}
