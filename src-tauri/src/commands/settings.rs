use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use claudette::db::Database;

use crate::state::AppState;

/// Spawn a short-lived process and reap it in a background thread to prevent zombies.
pub(crate) fn spawn_and_reap(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

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
                let _ = db.set_app_setting("tray_enabled", "false");
                return Err(format!("Failed to enable tray: {e}"));
            }
            // Immediately sync icon/tooltip to current agent state.
            crate::tray::rebuild_tray(&app);
        } else {
            crate::tray::destroy_tray(&app);
        }
    }

    Ok(())
}

/// Return available notification sound names for the current platform.
#[tauri::command]
pub fn list_notification_sounds() -> Vec<String> {
    #[allow(unused_mut)]
    let mut sounds = vec!["Default".to_string(), "None".to_string()];
    #[cfg(target_os = "macos")]
    if let Ok(entries) = std::fs::read_dir("/System/Library/Sounds") {
        let mut system: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path.extension().is_some_and(|ext| ext == "aiff") {
                    path.file_stem().map(|n| n.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();
        system.sort();
        sounds.extend(system);
    }
    sounds
}

/// Play a notification sound by name (for settings preview and agent-finished events).
#[tauri::command]
pub fn play_notification_sound(sound: String) {
    if sound == "None" {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let path = if sound == "Default" {
            "/System/Library/Sounds/Tink.aiff".to_string()
        } else {
            format!("/System/Library/Sounds/{sound}.aiff")
        };
        if let Ok(child) = std::process::Command::new("afplay").arg(&path).spawn() {
            spawn_and_reap(child);
        }
    }
    #[cfg(target_os = "linux")]
    {
        // On Linux, play the system "bell" or "message" sound via paplay/canberra.
        // "Default" maps to the desktop notification sound; named sounds are
        // looked up via the XDG sound theme.
        let sound_name = if sound == "Default" {
            "bell".to_string()
        } else {
            sound.to_lowercase()
        };
        if let Ok(child) = std::process::Command::new("canberra-gtk-play")
            .arg("-i")
            .arg(&sound_name)
            .spawn()
            .or_else(|_| {
                std::process::Command::new("paplay")
                    .arg(format!(
                        "/usr/share/sounds/freedesktop/stereo/{sound_name}.oga"
                    ))
                    .spawn()
            })
        {
            spawn_and_reap(child);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = sound;
    }
}

/// Build a Command for the notification shell command with env vars set.
/// Returns None if the command is empty.
pub(crate) fn build_notification_command(
    cmd: &str,
    title: &str,
    body: &str,
    workspace_id: &str,
    workspace_name: &str,
) -> Option<std::process::Command> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    let mut command = std::process::Command::new("sh");
    command
        .arg("-c")
        .arg(cmd)
        .env("CLAUDETTE_NOTIFICATION_TITLE", title)
        .env("CLAUDETTE_NOTIFICATION_BODY", body)
        .env("CLAUDETTE_WORKSPACE_ID", workspace_id)
        .env("CLAUDETTE_WORKSPACE_NAME", workspace_name);
    Some(command)
}

/// Run the user-configured notification command (if set) with context env vars.
#[tauri::command]
pub fn run_notification_command(
    title: String,
    body: String,
    workspace_id: String,
    workspace_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
        && let Some(mut command) =
            build_notification_command(&cmd, &title, &body, &workspace_id, &workspace_name)
        && let Ok(child) = command.spawn()
    {
        spawn_and_reap(child);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_notification_sounds_always_has_default_and_none() {
        let sounds = list_notification_sounds();
        assert!(sounds.len() >= 2);
        assert_eq!(sounds[0], "Default");
        assert_eq!(sounds[1], "None");
    }

    #[test]
    fn test_list_notification_sounds_no_duplicates() {
        let sounds = list_notification_sounds();
        let mut seen = std::collections::HashSet::new();
        for s in &sounds {
            assert!(seen.insert(s), "Duplicate sound: {s}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_list_notification_sounds_includes_system_sounds() {
        let sounds = list_notification_sounds();
        // macOS always has at least a few sounds in /System/Library/Sounds
        assert!(sounds.len() > 2, "Expected system sounds on macOS");
    }

    #[test]
    fn test_play_notification_sound_none_is_noop() {
        // Should not panic or spawn any process.
        play_notification_sound("None".to_string());
    }

    // --- Notification command tests ---

    #[test]
    fn test_build_notification_command_empty_returns_none() {
        assert!(build_notification_command("", "t", "b", "id", "name").is_none());
    }

    #[test]
    fn test_build_notification_command_sets_shell_and_args() {
        let cmd = build_notification_command("echo hello", "t", "b", "id", "name").unwrap();
        let program = cmd.get_program().to_string_lossy().to_string();
        assert_eq!(program, "sh");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-c", "echo hello"]);
    }

    #[test]
    fn test_build_notification_command_sets_env_vars() {
        let cmd = build_notification_command(
            "echo test",
            "My Title",
            "My Body",
            "ws-123",
            "my-workspace",
        )
        .unwrap();
        let envs: std::collections::HashMap<String, String> = cmd
            .get_envs()
            .filter_map(|(k, v)| {
                Some((
                    k.to_string_lossy().to_string(),
                    v?.to_string_lossy().to_string(),
                ))
            })
            .collect();
        assert_eq!(
            envs.get("CLAUDETTE_NOTIFICATION_TITLE").unwrap(),
            "My Title"
        );
        assert_eq!(envs.get("CLAUDETTE_NOTIFICATION_BODY").unwrap(), "My Body");
        assert_eq!(envs.get("CLAUDETTE_WORKSPACE_ID").unwrap(), "ws-123");
        assert_eq!(
            envs.get("CLAUDETTE_WORKSPACE_NAME").unwrap(),
            "my-workspace"
        );
    }

    #[test]
    fn test_notification_command_runs_and_receives_env() {
        // Actually spawn a process and verify env vars are passed through.
        let tmp = std::env::temp_dir().join("claudette-test-notify-cmd.txt");
        let cmd_str = format!(
            "echo $CLAUDETTE_NOTIFICATION_TITLE,$CLAUDETTE_NOTIFICATION_BODY > {}",
            tmp.display()
        );
        let mut command =
            build_notification_command(&cmd_str, "TestTitle", "TestBody", "ws-1", "ws-name")
                .unwrap();
        let mut child = command.spawn().expect("Failed to spawn test command");
        child.wait().expect("Failed to wait for test command");
        let output = std::fs::read_to_string(&tmp).expect("Failed to read output file");
        std::fs::remove_file(&tmp).ok();
        assert_eq!(output.trim(), "TestTitle,TestBody");
    }
}
