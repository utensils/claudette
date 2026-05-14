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

#[derive(Serialize, Deserialize, Debug)]
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
    #[cfg(windows)]
    if let Ok(entries) = std::fs::read_dir(claudette::audio::windows_media_dir()) {
        let mut system: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("wav"))
                {
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
    #[cfg(windows)]
    {
        // PlaySoundW plays at system volume — `vol` is treated as a mute
        // toggle (handled above by the `<= 0.0` early return). For named
        // sounds we look up `<windows-media-dir>\<name>.wav`; "Default"
        // maps to the system "Notification.Default" alias which respects
        // the user's chosen Default Beep in Sound settings.
        if sound == "Default" {
            // Try the modern "Notification.Default" alias first; fall
            // back to `SystemDefault` (NT-era) for older Windows. Both
            // are Win32 PlaySound aliases — no file paths involved.
            if !claudette::audio::play_alias_async("Notification.Default") {
                claudette::audio::play_alias_async("SystemDefault");
            }
        } else if !is_safe_sound_name(&sound) {
            // Reject path separators, drive letters, and `..` so a
            // setting like "..\..\Users\foo\secret" can't make us play
            // arbitrary WAV files outside the system Media directory.
            // `Path::join(absolute)` discards its base, so without this
            // guard a maliciously edited DB row could read any file the
            // user account can.
            tracing::warn!(
                target: "claudette::ui",
                sound = %sound,
                "notification sound name contains path syntax — refusing"
            );
        } else {
            let path = claudette::audio::windows_media_dir().join(format!("{sound}.wav"));
            if !claudette::audio::play_wav_file_async(&path) {
                tracing::debug!(
                    target: "claudette::ui",
                    path = %path.display(),
                    "notification sound not found or failed to play"
                );
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (sound, vol);
    }
}

/// Build a Command for the notification shell command with workspace env vars.
/// Returns None if the command is empty.
///
/// Shell selection:
/// - macOS / Linux: `sh -c <cmd>` (POSIX-compatible)
/// - Windows: `cmd.exe /S /C <cmd>` (the shell every Windows install has;
///   `/S` disables `cmd`'s special-character mangling so the user's
///   command is passed verbatim, and `/C` runs and exits)
///
/// Users who want `bash` semantics on Windows can write `bash -c "..."`
/// inside their command — `cmd /C` will resolve `bash` from PATH.
pub(crate) fn build_notification_command(
    cmd: &str,
    ws_env: &claudette::env::WorkspaceEnv,
) -> Option<std::process::Command> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    // Reject bare shell reserved keywords that will always fail with `sh -c`.
    // Users sometimes enter "done" instead of `say "done"`. The check is
    // POSIX-shell-specific — on Windows, `done` / `fi` / `esac` aren't
    // reserved words in `cmd.exe`, and a `done.bat` on PATH is a legitimate
    // command we shouldn't reject.
    #[cfg(not(windows))]
    if is_bare_shell_keyword(cmd) {
        return None;
    }
    #[cfg(not(windows))]
    let mut command = {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    #[cfg(windows)]
    let mut command = {
        let mut c = std::process::Command::new("cmd.exe");
        // /S = leave the command line alone (no double-quote stripping);
        // /C = execute the command and terminate.
        c.arg("/S").arg("/C").arg(cmd);
        c
    };
    command.no_console_window();
    ws_env.apply_std(&mut command);
    Some(command)
}

/// Returns true if `cmd` is a single POSIX-shell reserved keyword that
/// cannot be executed standalone (e.g. `done`, `then`, `fi`, `esac`).
/// Only consulted on the `sh -c` code path; Windows uses `cmd.exe`,
/// where these aren't keywords and may be the names of real commands.
#[cfg(not(windows))]
fn is_bare_shell_keyword(cmd: &str) -> bool {
    matches!(
        cmd,
        "done" | "then" | "else" | "elif" | "fi" | "esac" | "do" | "in"
    )
}

/// Validate that a notification sound name is a bare filename — no path
/// separators, no `..` segments, no drive prefixes. Used on Windows
/// where the name is concatenated into `<windows-media-dir>\<name>.wav`
/// and `Path::join(absolute)` would discard the base, opening a path-
/// traversal vector if a bad value made it into the settings DB.
#[cfg(windows)]
fn is_safe_sound_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if name.contains(['/', '\\']) || name.contains("..") {
        return false;
    }
    // Drive prefix like `C:` (any ASCII letter + colon at the start).
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    // Reserved DOS device names — Windows treats these specially even
    // without an extension. Belt-and-braces against malicious values
    // like `CON.wav` causing kernel-side weirdness.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
    .then_some(false)
    .unwrap_or(true)
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

/// Hex validation for Base16 slot values: accept `#rrggbb`, `rrggbb`,
/// `#rgb`, or `rgb` (case-insensitive). Returns true if the string is a
/// well-formed hex color.
fn is_valid_hex_color(s: &str) -> bool {
    let v = s.trim().strip_prefix('#').unwrap_or(s.trim());
    (v.len() == 3 || v.len() == 6) && v.chars().all(|c| c.is_ascii_hexdigit())
}

/// Look up a Base16 slot tolerantly: real-world schemes in the wild use
/// either `base0A` (Tinted Theming spec) or `base0a`. Accept both.
fn read_base16_slot<'a>(
    raw: &'a HashMap<String, serde_json::Value>,
    suffix: &str,
) -> Option<&'a str> {
    let upper = format!("base{suffix}");
    let lower = format!("base{}", suffix.to_lowercase());
    raw.get(&upper)
        .or_else(|| raw.get(&lower))
        .and_then(|v| v.as_str())
}

/// Parse a single user-theme JSON file. Tries the native Claudette shape first
/// (id/name/colors), then falls back to a permissive shape that accepts
/// Base16 schemes: any JSON object whose top-level fields include all 16
/// `base00`–`base0F` slots with valid hex values is captured as `colors`,
/// with `id` synthesized from `file_stem` and `name` from the `scheme`/`name`
/// field. Conversion to Claudette tokens happens in the frontend (see
/// utils/theme.ts).
///
/// Returns `Err(reason)` if the file is neither a Claudette theme nor a
/// well-formed Base16 scheme. Callers log the reason and skip — preserving
/// the underlying error makes "malformed JSON" easy to distinguish from
/// "valid JSON but unsupported shape" in the logs.
fn parse_theme_file(content: &str, file_stem: &str) -> Result<ThemeDefinition, String> {
    let native_err = match serde_json::from_str::<ThemeDefinition>(content) {
        Ok(theme) => return Ok(theme),
        Err(e) => e,
    };

    let raw: HashMap<String, serde_json::Value> = serde_json::from_str(content)
        .map_err(|e| format!("invalid JSON: {e} (native parse: {native_err})"))?;

    const BASE16_SUFFIXES: [&str; 16] = [
        "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "0A", "0B", "0C", "0D", "0E",
        "0F",
    ];
    // Every slot must exist AND be a valid hex string. Files that look almost
    // base16 but ship malformed colors are skipped here so they never reach
    // the frontend as broken Claudette themes.
    let mut missing: Vec<String> = Vec::new();
    for suffix in BASE16_SUFFIXES {
        match read_base16_slot(&raw, suffix) {
            Some(value) if is_valid_hex_color(value) => {}
            Some(_) => missing.push(format!("base{suffix} (invalid hex)")),
            None => missing.push(format!("base{suffix} (missing)")),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "not a Claudette theme (native parse: {native_err}); base16 fallback rejected: {}",
            missing.join(", ")
        ));
    }

    // Capture every string-valued top-level field so the frontend converter
    // can read `variant`, `scheme`, etc. alongside the base16 hex values.
    let colors: HashMap<String, String> = raw
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect();

    let name = colors
        .get("scheme")
        .or_else(|| colors.get("name"))
        .cloned()
        .unwrap_or_else(|| file_stem.to_string());
    let author = colors.get("author").cloned();
    let description = colors.get("description").cloned();

    Ok(ThemeDefinition {
        id: file_stem.to_string(),
        name,
        author,
        description,
        colors,
    })
}

#[tauri::command]
pub async fn list_user_themes() -> Result<Vec<ThemeDefinition>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let themes_dir = claudette::path::claudette_home().join("themes");

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
                    tracing::warn!(target: "claudette::ui", error = %e, "skipping unreadable theme directory entry");
                    continue;
                }
            };

            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }

            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > MAX_THEME_FILE_BYTES => {
                    tracing::warn!(
                        target: "claudette::ui",
                        path = %path.display(),
                        bytes = meta.len(),
                        "skipping theme file: too large"
                    );
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::ui",
                        path = %path.display(),
                        error = %e,
                        "skipping theme file: metadata failed"
                    );
                    continue;
                }
            }

            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::ui",
                        path = %path.display(),
                        error = %e,
                        "skipping theme file: read failed"
                    );
                    continue;
                }
            };

            let file_stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unnamed");

            match parse_theme_file(&content, file_stem) {
                Ok(theme) => themes.push(theme),
                Err(reason) => tracing::warn!(
                    target: "claudette::ui",
                    path = %path.display(),
                    reason = %reason,
                    "skipping theme file"
                ),
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
    fn parse_theme_file_native_claudette_shape() {
        let content = r##"{
            "id": "my-theme",
            "name": "My Theme",
            "author": "alice",
            "colors": {
                "accent-primary": "#ff00aa",
                "app-bg": "#111111"
            }
        }"##;
        let theme = parse_theme_file(content, "my-theme").expect("should parse");
        assert_eq!(theme.id, "my-theme");
        assert_eq!(theme.name, "My Theme");
        assert_eq!(theme.author.as_deref(), Some("alice"));
        assert_eq!(
            theme.colors.get("accent-primary").map(|s| s.as_str()),
            Some("#ff00aa")
        );
    }

    #[test]
    fn parse_theme_file_canonical_base16() {
        // Canonical Base16 Tomorrow Night (top-level baseXX keys, no `colors` wrapper).
        let content = r#"{
            "scheme": "Tomorrow Night",
            "author": "Chris Kempson",
            "base00": "1d1f21", "base01": "282a2e", "base02": "373b41", "base03": "969896",
            "base04": "b4b7b4", "base05": "c5c8c6", "base06": "e0e0e0", "base07": "ffffff",
            "base08": "cc6666", "base09": "de935f", "base0A": "f0c674", "base0B": "b5bd68",
            "base0C": "8abeb7", "base0D": "81a2be", "base0E": "b294bb", "base0F": "a3685a"
        }"#;
        let theme = parse_theme_file(content, "tomorrow-night").expect("should parse");
        assert_eq!(theme.id, "tomorrow-night");
        assert_eq!(theme.name, "Tomorrow Night"); // from `scheme`
        assert_eq!(theme.author.as_deref(), Some("Chris Kempson"));
        // All 16 base keys preserved as-is for the frontend to convert.
        for key in [
            "base00", "base01", "base02", "base03", "base04", "base05", "base06", "base07",
            "base08", "base09", "base0A", "base0B", "base0C", "base0D", "base0E", "base0F",
        ] {
            assert!(theme.colors.contains_key(key), "missing base16 key: {key}");
        }
    }

    #[test]
    fn parse_theme_file_base16_falls_back_to_stem_when_no_scheme() {
        let content = r#"{
            "base00": "000000", "base01": "111111", "base02": "222222", "base03": "333333",
            "base04": "444444", "base05": "555555", "base06": "666666", "base07": "777777",
            "base08": "880000", "base09": "990000", "base0A": "aa0000", "base0B": "bb0000",
            "base0C": "cc0000", "base0D": "dd0000", "base0E": "ee0000", "base0F": "ff0000"
        }"#;
        let theme = parse_theme_file(content, "anon-scheme").expect("should parse");
        assert_eq!(theme.id, "anon-scheme");
        assert_eq!(theme.name, "anon-scheme");
        assert!(theme.author.is_none());
    }

    #[test]
    fn parse_theme_file_skips_partial_base16() {
        // Missing base0F — not a complete base16 scheme, and not native Claudette.
        let content = r#"{
            "base00": "000000", "base01": "111111", "base02": "222222", "base03": "333333",
            "base04": "444444", "base05": "555555", "base06": "666666", "base07": "777777",
            "base08": "880000", "base09": "990000", "base0A": "aa0000", "base0B": "bb0000",
            "base0C": "cc0000", "base0D": "dd0000", "base0E": "ee0000"
        }"#;
        let err = parse_theme_file(content, "partial").unwrap_err();
        assert!(
            err.contains("base0F"),
            "error should mention missing slot: {err}"
        );
        assert!(
            err.contains("missing"),
            "error should distinguish missing vs invalid: {err}"
        );
    }

    #[test]
    fn parse_theme_file_rejects_invalid_hex_in_base16_slot() {
        // All 16 slots present, but base05 is not a valid hex value — the file
        // must be rejected with a clear reason instead of leaking to the frontend.
        let content = r#"{
            "base00": "000000", "base01": "111111", "base02": "222222", "base03": "333333",
            "base04": "444444", "base05": "not-a-hex", "base06": "666666", "base07": "777777",
            "base08": "880000", "base09": "990000", "base0A": "aa0000", "base0B": "bb0000",
            "base0C": "cc0000", "base0D": "dd0000", "base0E": "ee0000", "base0F": "ff0000"
        }"#;
        let err = parse_theme_file(content, "broken").unwrap_err();
        assert!(
            err.contains("base05"),
            "error should name the bad slot: {err}"
        );
        assert!(
            err.contains("invalid hex"),
            "error should distinguish invalid hex: {err}"
        );
    }

    #[test]
    fn parse_theme_file_accepts_lowercase_base16_keys() {
        // Some legacy base16 schemes ship lowercase `base0a`–`base0f`. Both
        // casings must parse to the same shape.
        let content = r#"{
            "base00": "000000", "base01": "111111", "base02": "222222", "base03": "333333",
            "base04": "444444", "base05": "555555", "base06": "666666", "base07": "777777",
            "base08": "880000", "base09": "990000", "base0a": "aa0000", "base0b": "bb0000",
            "base0c": "cc0000", "base0d": "dd0000", "base0e": "ee0000", "base0f": "ff0000"
        }"#;
        let theme = parse_theme_file(content, "lower").expect("should parse");
        assert!(theme.colors.contains_key("base0a"));
    }

    #[test]
    fn parse_theme_file_preserves_underlying_parse_error() {
        let err = parse_theme_file("{ not valid json", "broken").unwrap_err();
        assert!(
            err.contains("invalid JSON"),
            "error should include the parse failure: {err}"
        );

        let empty_err = parse_theme_file("", "empty").unwrap_err();
        assert!(
            empty_err.contains("invalid JSON"),
            "empty file error should be clear: {empty_err}"
        );
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

    #[cfg(windows)]
    #[test]
    fn test_list_notification_sounds_includes_system_sounds_windows() {
        let sounds = list_notification_sounds();
        // Every Windows install ships several `.wav` files under the
        // Media directory (chimes, ding, notify, tada, …). If this
        // assertion ever fails on a stripped CI image, fall back to
        // gating it the same way Linux is gated above.
        let media_dir = claudette::audio::windows_media_dir();
        assert!(
            sounds.len() > 2,
            "Expected system sounds enumerated from {}",
            media_dir.display()
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_is_safe_sound_name_rejects_path_syntax() {
        // Bare filenames pass — they're what the dropdown produces.
        assert!(super::is_safe_sound_name("Windows Notify"));
        assert!(super::is_safe_sound_name("chimes"));
        assert!(super::is_safe_sound_name("Speech On"));
        // Path traversal: separators, drive prefixes, parent refs.
        assert!(!super::is_safe_sound_name("../../etc/passwd"));
        assert!(!super::is_safe_sound_name("..\\..\\Windows\\System32\\foo"));
        assert!(!super::is_safe_sound_name("C:\\Windows\\Media\\chimes"));
        assert!(!super::is_safe_sound_name("D:foo"));
        assert!(!super::is_safe_sound_name("subdir/chimes"));
        assert!(!super::is_safe_sound_name("subdir\\chimes"));
        // Empty.
        assert!(!super::is_safe_sound_name(""));
        // Reserved DOS device names — case-insensitive.
        assert!(!super::is_safe_sound_name("CON"));
        assert!(!super::is_safe_sound_name("nul"));
        assert!(!super::is_safe_sound_name("LPT1"));
    }

    #[cfg(windows)]
    #[test]
    fn test_build_notification_command_allows_done_dot_bat_on_windows() {
        // POSIX shells reject bare `done`; Windows users may have a
        // `done.bat` on PATH that is a real command. The check must be
        // gated to non-Windows so legitimate `cmd.exe` invocations
        // aren't rejected.
        assert!(build_notification_command("done.bat", &sample_ws_env()).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn test_build_notification_command_rejects_bare_done_posix() {
        // On macOS / Linux the rejection still applies — running bare
        // `done` against `sh -c` is always a parse error from the user
        // forgetting to quote the surrounding say/echo.
        assert!(build_notification_command("done", &sample_ws_env()).is_none());
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
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        #[cfg(not(windows))]
        {
            assert_eq!(program, "sh");
            assert_eq!(args, vec!["-c", "echo hello"]);
        }
        #[cfg(windows)]
        {
            // `cmd.exe` keeps its `.exe` suffix when constructed via
            // `Command::new("cmd.exe")` — assert on the basename so a
            // future switch to bare `"cmd"` (or full path) doesn't break
            // this test.
            assert!(
                program.eq_ignore_ascii_case("cmd.exe") || program.eq_ignore_ascii_case("cmd"),
                "expected cmd shell on Windows, got {program}"
            );
            assert_eq!(args, vec!["/S", "/C", "echo hello"]);
        }
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
        // Verify env vars are passed through to the spawned shell. Shell
        // syntax differs by platform: `sh` reads `$VAR`, `cmd.exe` reads
        // `%VAR%`. We capture stdout rather than shell-redirecting to a
        // temp file — the latter forces us into platform-specific quote
        // rules (`cmd /S /C` does not honour `\"` the way Rust's stock
        // arg-quoter emits them) and the captured-stdout path is just as
        // good a check that env vars reached the child.
        #[cfg(not(windows))]
        let cmd_str = "echo $CLAUDETTE_WORKSPACE_NAME,$CLAUDETTE_ROOT_PATH".to_string();
        #[cfg(windows)]
        let cmd_str = "echo %CLAUDETTE_WORKSPACE_NAME%,%CLAUDETTE_ROOT_PATH%".to_string();
        let mut command = build_notification_command(&cmd_str, &sample_ws_env()).unwrap();
        let output = command.output().expect("Failed to run test command");
        assert!(
            output.status.success(),
            "shell command failed: status={:?} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).expect("stdout was not utf-8");
        assert_eq!(stdout.trim(), "my-workspace,/home/user/repo");
    }
}
