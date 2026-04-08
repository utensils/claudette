use std::collections::HashMap;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use tauri::State;

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

#[derive(Serialize, Deserialize)]
pub struct SoundPackManifest {
    pub id: String,
    pub name: String,
    pub author: Option<String>,
    pub description: Option<String>,
    pub sounds: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct SoundPackInfo {
    pub manifest: SoundPackManifest,
    pub base_path: String,
}

#[tauri::command]
pub async fn list_user_sound_packs() -> Result<Vec<SoundPackInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let sounds_dir = dirs::home_dir()
            .ok_or("Could not determine home directory")?
            .join(".claudette")
            .join("sounds");

        if !sounds_dir.exists() {
            return Ok(Vec::new());
        }

        let mut packs = Vec::new();
        let entries = std::fs::read_dir(&sounds_dir).map_err(|e| e.to_string())?;
        const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
        const MAX_SOUND_FILE_BYTES: u64 = 2 * 1024 * 1024;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[sounds] Skipping unreadable directory entry: {e}");
                    continue;
                }
            };

            let pack_dir = entry.path();
            if !pack_dir.is_dir() {
                continue;
            }

            let manifest_path = pack_dir.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            }

            match std::fs::metadata(&manifest_path) {
                Ok(meta) if meta.len() > MAX_MANIFEST_BYTES => {
                    eprintln!(
                        "[sounds] Skipping {}: manifest too large ({} bytes)",
                        pack_dir.display(),
                        meta.len()
                    );
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[sounds] Skipping {}: {e}", pack_dir.display());
                    continue;
                }
            }

            let content = match std::fs::read_to_string(&manifest_path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[sounds] Skipping {}: {e}", pack_dir.display());
                    continue;
                }
            };

            let manifest = match serde_json::from_str::<SoundPackManifest>(&content) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[sounds] Skipping {}: {e}", pack_dir.display());
                    continue;
                }
            };

            // Validate that referenced sound files exist and aren't too large.
            let mut valid = true;
            for (event, filename) in &manifest.sounds {
                // Reject path traversal.
                if filename.contains("..") || filename.starts_with('/') {
                    eprintln!(
                        "[sounds] Skipping {}: invalid path for event '{event}': {filename}",
                        pack_dir.display()
                    );
                    valid = false;
                    break;
                }
                let sound_path = pack_dir.join(filename);
                match std::fs::metadata(&sound_path) {
                    Ok(meta) if meta.len() > MAX_SOUND_FILE_BYTES => {
                        eprintln!(
                            "[sounds] Skipping {}: sound file too large ({} bytes): {filename}",
                            pack_dir.display(),
                            meta.len()
                        );
                        valid = false;
                        break;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!(
                            "[sounds] Skipping {}: missing sound file '{filename}': {e}",
                            pack_dir.display()
                        );
                        valid = false;
                        break;
                    }
                }
            }

            if valid {
                packs.push(SoundPackInfo {
                    manifest,
                    base_path: pack_dir.to_string_lossy().into_owned(),
                });
            }
        }

        Ok(packs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a sound file from a custom sound pack and return it as a data URI.
#[tauri::command]
pub async fn read_sound_file(base_path: String, filename: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Reject path traversal.
        if filename.contains("..") || filename.starts_with('/') {
            return Err(format!("Invalid sound filename: {filename}"));
        }

        let sounds_dir = dirs::home_dir()
            .ok_or("Could not determine home directory")?
            .join(".claudette")
            .join("sounds");

        let path = std::path::Path::new(&base_path).join(&filename);

        // Ensure the resolved path is within the sounds directory.
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let canonical_sounds = sounds_dir.canonicalize().unwrap_or(sounds_dir);
        if !canonical.starts_with(&canonical_sounds) {
            return Err("Sound file is outside the sounds directory".to_string());
        }

        const MAX_SOUND_FILE_BYTES: u64 = 2 * 1024 * 1024;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_SOUND_FILE_BYTES {
            return Err(format!("Sound file too large: {} bytes", meta.len()));
        }

        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        let mime = match path.extension().and_then(|e| e.to_str()) {
            Some("wav") => "audio/wav",
            Some("mp3") => "audio/mpeg",
            Some("ogg") => "audio/ogg",
            _ => "application/octet-stream",
        };

        Ok(format!("data:{mime};base64,{}", BASE64.encode(&data)))
    })
    .await
    .map_err(|e| e.to_string())?
}
