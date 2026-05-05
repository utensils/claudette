use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use claudette::db::Database;

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

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

    // Live-apply tray icon style changes. `rebuild_tray` re-reads the
    // setting from the DB, so the value we just wrote takes effect on
    // the next call — no restart required. No-op if the tray isn't
    // currently active (destroy_tray clears the handle).
    if key == "tray_icon_style" {
        crate::tray::rebuild_tray(&app);
    }

    // Language changes: rebuild the tray so menu labels, status icons,
    // and tooltip retranslate without a restart. Same pattern as
    // tray_icon_style — `rebuild_tray` re-reads the locale from the DB.
    if key == "language" {
        crate::tray::rebuild_tray(&app);
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_app_setting(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_app_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_app_settings_with_prefix(
    prefix: String,
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_app_settings_with_prefix(&prefix)
        .map_err(|e| e.to_string())
}

/// Read the global `git config user.name` and return it as a branch-safe slug.
#[tauri::command]
pub async fn get_git_username() -> Result<Option<String>, String> {
    let name = claudette::git::get_git_username()
        .await
        .map_err(|e| e.to_string())?;
    Ok(name.map(|n| claudette::agent::sanitize_branch_name(&n, 30)))
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

/// Cached system font list — populated on first call, reused thereafter.
static SYSTEM_FONTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

/// Return available system font family names for the current platform.
///
/// - macOS: queries Core Text via a small Swift script (always available).
/// - Linux: queries fontconfig via `fc-list`.
///
/// Result is cached after the first call.
#[tauri::command]
pub async fn list_system_fonts() -> Vec<String> {
    if let Some(cached) = SYSTEM_FONTS.get() {
        return cached.clone();
    }
    // `mut` is only reached from the per-target blocks below; Windows has
    // neither branch, so the binding stays immutable there.
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(unused_mut))]
    let mut families = std::collections::BTreeSet::<String>::new();

    #[cfg(target_os = "macos")]
    {
        // Swift is always available on macOS; NSFontManager is the canonical API.
        let script = r#"import AppKit; NSFontManager.shared.availableFontFamilies.sorted().forEach { print($0) }"#;
        if let Ok(output) = tokio::process::Command::new("/usr/bin/swift")
            .no_console_window()
            .arg("-e")
            .arg(script)
            .output()
            .await
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let name = line.trim();
                if !name.is_empty() && !name.starts_with('.') {
                    families.insert(name.to_string());
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // fontconfig is standard on all Linux desktops.
        if let Ok(output) = tokio::process::Command::new("fc-list")
            .no_console_window()
            .args([":", "family"])
            .output()
            .await
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                // fc-list may return comma-separated aliases: "DejaVu Sans,DejaVu Sans Condensed"
                for name in line.split(',') {
                    let name = name.trim();
                    if !name.is_empty() {
                        families.insert(name.to_string());
                    }
                }
            }
        }
    }

    let result: Vec<String> = families.into_iter().collect();
    // Only cache if we got results — an empty list likely means the
    // subprocess failed, and we don't want to permanently cache that.
    if !result.is_empty() {
        let _ = SYSTEM_FONTS.set(result.clone());
    }
    result
}

/// Play a notification sound by name (for settings preview and agent-finished events).
#[tauri::command]
pub fn play_notification_sound(sound: String, volume: Option<f64>) {
    if sound == "None" {
        return;
    }
    let vol = volume
        .filter(|v| v.is_finite())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    if vol <= 0.0 {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let path = if sound == "Default" {
            "/System/Library/Sounds/Tink.aiff".to_string()
        } else {
            format!("/System/Library/Sounds/{sound}.aiff")
        };
        if let Ok(child) = std::process::Command::new("afplay")
            .no_console_window()
            .arg("-v")
            .arg(format!("{vol}"))
            .arg(&path)
            .spawn()
        {
            spawn_and_reap(child);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let sound_name = if sound == "Default" {
            "bell".to_string()
        } else {
            sound.to_lowercase()
        };
        let pa_volume = (vol * 65536.0) as u32;
        if let Ok(child) = std::process::Command::new("canberra-gtk-play")
            .no_console_window()
            .arg("-i")
            .arg(&sound_name)
            .spawn()
            .or_else(|_| {
                std::process::Command::new("paplay")
                    .no_console_window()
                    .arg("--volume")
                    .arg(pa_volume.to_string())
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
        let _ = (sound, vol);
    }
}

/// Build a Command for the notification shell command with workspace env vars.
/// Returns None if the command is empty.
pub(crate) fn build_notification_command(
    cmd: &str,
    ws_env: &claudette::env::WorkspaceEnv,
) -> Option<std::process::Command> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    // Reject bare shell reserved keywords that will always fail with `sh -c`.
    // Users sometimes enter "done" instead of `say "done"`.
    if is_bare_shell_keyword(cmd) {
        return None;
    }
    let mut command = std::process::Command::new("sh");
    command.no_console_window();
    command.arg("-c").arg(cmd);
    ws_env.apply_std(&mut command);
    Some(command)
}

/// Returns true if `cmd` is a single shell reserved keyword that cannot
/// be executed standalone (e.g. `done`, `then`, `fi`, `esac`).
fn is_bare_shell_keyword(cmd: &str) -> bool {
    matches!(
        cmd,
        "done" | "then" | "else" | "elif" | "fi" | "esac" | "do" | "in"
    )
}

/// Run the user-configured notification command (if set) with workspace env vars.
#[tauri::command]
pub fn run_notification_command(
    workspace_name: String,
    workspace_id: String,
    workspace_path: String,
    root_path: String,
    default_branch: String,
    branch_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ws_env = claudette::env::WorkspaceEnv {
        workspace_name,
        workspace_id,
        workspace_path,
        root_path,
        default_branch,
        branch_name,
    };
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
        && let Some(mut command) = build_notification_command(&cmd, &ws_env)
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
        play_notification_sound("None".to_string(), None);
    }

    // --- Notification command tests ---

    fn sample_ws_env() -> claudette::env::WorkspaceEnv {
        claudette::env::WorkspaceEnv {
            workspace_name: "my-workspace".into(),
            workspace_id: "ws-123".into(),
            workspace_path: "/tmp/worktrees/repo/my-workspace".into(),
            root_path: "/home/user/repo".into(),
            default_branch: "main".into(),
            branch_name: "claudette/my-workspace".into(),
        }
    }

    #[test]
    fn test_build_notification_command_empty_returns_none() {
        assert!(build_notification_command("", &sample_ws_env()).is_none());
    }

    #[test]
    fn test_build_notification_command_sets_shell_and_args() {
        let cmd = build_notification_command("echo hello", &sample_ws_env()).unwrap();
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
        let cmd = build_notification_command("echo test", &sample_ws_env()).unwrap();
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
            envs.get("CLAUDETTE_WORKSPACE_NAME").unwrap(),
            "my-workspace"
        );
        assert_eq!(envs.get("CLAUDETTE_WORKSPACE_ID").unwrap(), "ws-123");
        assert_eq!(
            envs.get("CLAUDETTE_WORKSPACE_PATH").unwrap(),
            "/tmp/worktrees/repo/my-workspace"
        );
        assert_eq!(envs.get("CLAUDETTE_ROOT_PATH").unwrap(), "/home/user/repo");
        assert_eq!(envs.get("CLAUDETTE_DEFAULT_BRANCH").unwrap(), "main");
        assert_eq!(
            envs.get("CLAUDETTE_BRANCH_NAME").unwrap(),
            "claudette/my-workspace"
        );
    }

    #[test]
    fn test_notification_command_runs_and_receives_env() {
        // Actually spawn a process and verify env vars are passed through.
        let tmp = std::env::temp_dir().join("claudette-test-notify-cmd.txt");
        let cmd_str = format!(
            "echo $CLAUDETTE_WORKSPACE_NAME,$CLAUDETTE_ROOT_PATH > {}",
            tmp.display()
        );
        let mut command = build_notification_command(&cmd_str, &sample_ws_env()).unwrap();
        let mut child = command.spawn().expect("Failed to spawn test command");
        child.wait().expect("Failed to wait for test command");
        let output = std::fs::read_to_string(&tmp).expect("Failed to read output file");
        std::fs::remove_file(&tmp).ok();
        assert_eq!(output.trim(), "my-workspace,/home/user/repo");
    }
}
