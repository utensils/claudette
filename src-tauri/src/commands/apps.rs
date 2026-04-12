use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

const DEFAULT_APPS_JSON: &str = include_str!("../../default-apps.json");

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppCategory {
    Editor,
    Terminal,
    Ide,
}

/// Entry in the user-editable apps.json config.
#[derive(Debug, Clone, Deserialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub category: AppCategory,
    #[serde(default)]
    pub bin_names: Vec<String>,
    #[serde(default)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub mac_app_names: Vec<String>,
    pub open_args: Vec<String>,
    #[serde(default)]
    pub needs_terminal: bool,
}

/// The apps.json file structure.
#[derive(Debug, Clone, Deserialize)]
pub struct AppsConfig {
    pub apps: Vec<AppEntry>,
}

/// App that passed detection (returned to frontend).
#[derive(Debug, Clone, Serialize)]
pub struct DetectedApp {
    pub id: String,
    pub name: String,
    pub category: AppCategory,
    /// The resolved binary path or .app bundle path.
    pub detected_path: String,
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/// Resolve the path to the user's apps.json config file.
fn apps_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claudette").join("apps.json"))
}

/// Load and parse apps.json from the given path.
/// If the file doesn't exist, write the embedded default and return it.
/// If the file is malformed, log a warning and return the embedded default.
fn load_apps_config_from(path: &Path) -> AppsConfig {
    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<AppsConfig>(&content) {
                Ok(config) => return config,
                Err(e) => eprintln!("[apps] Failed to parse {}: {e}", path.display()),
            },
            Err(e) => eprintln!("[apps] Failed to read {}: {e}", path.display()),
        }
    } else {
        // Write the default file for the user to discover and customize.
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(path, DEFAULT_APPS_JSON) {
            eprintln!(
                "[apps] Failed to write default config to {}: {e}",
                path.display()
            );
        }
    }
    // Fallback: the embedded default always parses.
    serde_json::from_str(DEFAULT_APPS_JSON).expect("embedded default-apps.json must be valid")
}

/// Public entry point — resolves ~/.claudette/apps.json and loads it.
fn load_apps_config() -> AppsConfig {
    match apps_config_path() {
        Some(path) => load_apps_config_from(&path),
        None => serde_json::from_str(DEFAULT_APPS_JSON)
            .expect("embedded default-apps.json must be valid"),
    }
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

/// Well-known PATH prefixes that macOS GUI apps may not inherit.
const EXTRA_PATH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/sbin"];

/// Build the list of directories to scan for binaries.
fn build_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for dir in EXTRA_PATH_DIRS {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            dirs.push(dir);
        }
    }

    // Deduplicate while preserving order.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// Check whether `name` exists as an executable in any of `path_dirs`.
/// Returns the full path to the first match, or `None`.
fn find_binary(name: &str, path_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in path_dirs {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // On Unix, verify the executable bit is set.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return Some(candidate);
    }
    None
}

/// Check whether a .app bundle exists in /Applications (macOS only).
#[cfg(target_os = "macos")]
fn find_mac_app(app_name: &str) -> Option<PathBuf> {
    if app_name == "__always__" {
        // Sentinel: always detected on macOS (e.g. Terminal.app).
        return Some(PathBuf::from("/System/Applications/Utilities/Terminal.app"));
    }
    let path = PathBuf::from("/Applications").join(app_name);
    if path.exists() { Some(path) } else { None }
}

/// Detect installed apps from the given config, searching the provided PATH dirs.
/// This is the testable core — `detect_from_config` wraps it with the real PATH.
fn detect_with_paths(config: &AppsConfig, path_dirs: &[PathBuf]) -> Vec<DetectedApp> {
    let category_order = |c: &AppCategory| -> u8 {
        match c {
            AppCategory::Editor => 0,
            AppCategory::Terminal => 1,
            AppCategory::Ide => 2,
        }
    };

    let mut detected: Vec<DetectedApp> = Vec::new();

    for entry in &config.apps {
        // Try bin_names first.
        if let Some(bin_path) = entry
            .bin_names
            .iter()
            .find_map(|name| find_binary(name, path_dirs))
        {
            detected.push(DetectedApp {
                id: entry.id.clone(),
                name: entry.name.clone(),
                category: entry.category,
                detected_path: bin_path.to_string_lossy().to_string(),
            });
            continue;
        }

        // Try mac_app_names (macOS only).
        #[cfg(target_os = "macos")]
        if let Some(app_path) = entry
            .mac_app_names
            .iter()
            .find_map(|name| find_mac_app(name))
        {
            detected.push(DetectedApp {
                id: entry.id.clone(),
                name: entry.name.clone(),
                category: entry.category,
                detected_path: app_path.to_string_lossy().to_string(),
            });
            continue;
        }
    }

    detected.sort_by(|a, b| {
        category_order(&a.category)
            .cmp(&category_order(&b.category))
            .then_with(|| a.name.cmp(&b.name))
    });

    detected
}

/// Public detection entry point using the real system PATH.
fn detect_from_config(config: &AppsConfig) -> Vec<DetectedApp> {
    let path_dirs = build_path_dirs();
    detect_with_paths(config, &path_dirs)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

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

/// Launch an app using macOS `open -a` command.
#[cfg(target_os = "macos")]
async fn open_macos_app(app_name: &str, worktree_path: &str) -> Result<(), String> {
    tokio::process::Command::new("open")
        .args(["-a", app_name, worktree_path])
        .spawn()
        .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
    Ok(())
}

/// Launch a terminal app via AppleScript (iTerm2, Terminal.app).
/// Uses `on run argv` + `quoted form of` to pass the path as an argument,
/// avoiding string interpolation and AppleScript injection risks.
#[cfg(target_os = "macos")]
async fn open_applescript(app_id: &str, worktree_path: &str) -> Result<(), String> {
    let script = match app_id {
        "iterm2" => {
            r#"on run argv
    set p to item 1 of argv
    set cmd to "cd " & quoted form of p & " && exec $SHELL"
    tell application "iTerm"
        activate
        create window with default profile command cmd
    end tell
end run"#
        }
        "macos-terminal" => {
            r#"on run argv
    set p to item 1 of argv
    set cmd to "cd " & quoted form of p
    tell application "Terminal"
        activate
        do script cmd
    end tell
end run"#
        }
        other => return Err(format!("No AppleScript handler for app '{other}'")),
    };

    tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(worktree_path)
        .spawn()
        .map_err(|e| format!("Failed to run AppleScript for {app_id}: {e}"))?;
    Ok(())
}

/// Determine the exec-separator args for launching an editor inside a given terminal.
fn terminal_exec_args(terminal_id: &str) -> &'static [&'static str] {
    match terminal_id {
        "alacritty" | "konsole" | "xfce4-terminal" => &["-e"],
        "gnome-terminal" => &["--"],
        // kitty, foot, wezterm, ghostty: just append the command directly.
        _ => &[],
    }
}

/// Launch a TUI editor via AppleScript when only .app-bundle terminals are available (macOS).
#[cfg(target_os = "macos")]
async fn open_tui_via_applescript(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    terminal: &DetectedApp,
) -> Result<(), String> {
    // Build the shell command: cd '<path>' && <editor> <args>
    // The editor's open_args may include flags; substitute {} with ".".
    let mut editor_argv = vec![editor_detected.detected_path.clone()];
    for arg in &editor_entry.open_args {
        editor_argv.push(arg.replace("{}", "."));
    }
    let editor_cmd = editor_argv.join(" ");

    let (app_name, script) = if terminal.id == "iterm2" {
        (
            "iTerm",
            r#"on run argv
    set p to item 1 of argv
    set e to item 2 of argv
    set cmd to "cd " & quoted form of p & " && " & e
    tell application "iTerm"
        activate
        create window with default profile command cmd
    end tell
end run"#,
        )
    } else {
        (
            "Terminal",
            r#"on run argv
    set p to item 1 of argv
    set e to item 2 of argv
    set cmd to "cd " & quoted form of p & " && " & e
    tell application "Terminal"
        activate
        do script cmd
    end tell
end run"#,
        )
    };

    tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(worktree_path)
        .arg(&editor_cmd)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to launch {} in {app_name} via AppleScript: {e}",
                editor_entry.name
            )
        })?;
    Ok(())
}

/// Launch a TUI editor (needs_terminal=true) inside the best detected terminal.
/// Prefers terminals detected via binary path; falls back to AppleScript on macOS
/// when only .app-bundle terminals are available.
async fn open_in_terminal(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let config = load_apps_config();

    let detected_apps = state.detected_apps.read().await;

    // Prefer a terminal detected via a real binary (not a .app bundle),
    // because .app paths can't be passed to Command::new directly.
    let terminal = detected_apps
        .iter()
        .filter(|a| a.category == AppCategory::Terminal)
        .find(|a| !a.detected_path.ends_with(".app"))
        .or_else(|| {
            detected_apps
                .iter()
                .find(|a| a.category == AppCategory::Terminal)
        })
        .ok_or("No terminal emulator detected — cannot launch TUI editor")?
        .clone();
    drop(detected_apps);

    // If the terminal was detected via .app bundle, use AppleScript on macOS.
    #[cfg(target_os = "macos")]
    if terminal.detected_path.ends_with(".app") {
        return open_tui_via_applescript(editor_entry, editor_detected, worktree_path, &terminal)
            .await;
    }

    let terminal_entry = config
        .apps
        .iter()
        .find(|a| a.id == terminal.id)
        .ok_or_else(|| format!("Terminal '{}' not found in config", terminal.id))?;

    // Build: terminal_binary [terminal_open_args with {} -> path] [exec_separator] editor_binary [editor_open_args]
    let mut cmd = tokio::process::Command::new(&terminal.detected_path);

    for arg in &terminal_entry.open_args {
        cmd.arg(arg.replace("{}", worktree_path));
    }

    for arg in terminal_exec_args(&terminal.id) {
        cmd.arg(arg);
    }

    // Use the editor's configured open_args, substituting {} with "."
    // (cwd is already set by the terminal's --working-directory flag).
    cmd.arg(&editor_detected.detected_path);
    for arg in &editor_entry.open_args {
        cmd.arg(arg.replace("{}", "."));
    }

    cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch {} in {}: {e}",
            editor_entry.name, terminal.name
        )
    })?;
    Ok(())
}

#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Reload config each time so user edits take effect without restart.
    let config = load_apps_config();
    let entry = config
        .apps
        .iter()
        .find(|a| a.id == app_id)
        .ok_or_else(|| format!("App '{app_id}' not found in apps.json"))?
        .clone();

    // Handle AppleScript sentinel (iTerm2, Terminal.app).
    #[cfg(target_os = "macos")]
    if entry
        .open_args
        .first()
        .is_some_and(|a| a == "__applescript__")
    {
        return open_applescript(&app_id, &worktree_path).await;
    }

    // Handle __open_a__ sentinel (Xcode) — look up detected_path to get the .app bundle.
    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__open_a__") {
        let detected_apps = state.detected_apps.read().await;
        let detected = detected_apps
            .iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("App '{app_id}' not detected on this system"))?;
        let app_path = detected.detected_path.clone();
        drop(detected_apps);
        return open_macos_app(&app_path, &worktree_path).await;
    }

    // Look up the detected path for this app.
    let detected_apps = state.detected_apps.read().await;
    let detected = detected_apps
        .iter()
        .find(|a| a.id == app_id)
        .ok_or_else(|| format!("App '{app_id}' not detected on this system"))?
        .clone();
    drop(detected_apps);

    // Handle TUI editors that need a terminal host.
    if entry.needs_terminal {
        return open_in_terminal(&entry, &detected, &worktree_path, &state).await;
    }

    // Handle .app-only detection on macOS (CLI not in PATH).
    #[cfg(target_os = "macos")]
    if detected.detected_path.ends_with(".app") {
        return open_macos_app(&detected.detected_path, &worktree_path).await;
    }

    // Normal binary launch: substitute {} in open_args with the worktree path.
    let args: Vec<String> = entry
        .open_args
        .iter()
        .map(|a| a.replace("{}", &worktree_path))
        .collect();

    tokio::process::Command::new(&detected.detected_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", entry.name))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_config() {
        let json = r#"{
            "apps": [{
                "id": "test-editor",
                "name": "Test Editor",
                "category": "editor",
                "bin_names": ["testedit"],
                "mac_app_names": ["Test Editor.app"],
                "open_args": ["{}"],
                "needs_terminal": false
            }]
        }"#;
        let config: AppsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.apps.len(), 1);
        assert_eq!(config.apps[0].id, "test-editor");
        assert_eq!(config.apps[0].name, "Test Editor");
        assert_eq!(config.apps[0].category, AppCategory::Editor);
        assert_eq!(config.apps[0].bin_names, vec!["testedit"]);
        assert_eq!(config.apps[0].open_args, vec!["{}"]);
        assert!(!config.apps[0].needs_terminal);
    }

    #[test]
    fn parse_optional_fields_use_defaults() {
        let json = r#"{
            "apps": [{
                "id": "minimal",
                "name": "Minimal",
                "category": "terminal",
                "open_args": ["--dir", "{}"]
            }]
        }"#;
        let config: AppsConfig = serde_json::from_str(json).unwrap();
        let app = &config.apps[0];
        assert!(app.bin_names.is_empty());
        assert!(app.mac_app_names.is_empty());
        assert!(!app.needs_terminal);
    }

    #[test]
    fn parse_malformed_json_is_err() {
        let result = serde_json::from_str::<AppsConfig>("not valid json {{{");
        assert!(result.is_err());
    }

    #[test]
    fn parse_unknown_fields_ignored() {
        let json = r#"{
            "apps": [{
                "id": "x",
                "name": "X",
                "category": "ide",
                "open_args": ["{}"],
                "future_field": true,
                "another": 42
            }],
            "version": 99
        }"#;
        let config: AppsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.apps[0].id, "x");
        assert_eq!(config.apps[0].category, AppCategory::Ide);
    }

    #[test]
    fn parse_embedded_default_config() {
        let config: AppsConfig =
            serde_json::from_str(DEFAULT_APPS_JSON).expect("default-apps.json must parse");
        assert!(config.apps.len() >= 15, "expected at least 15 default apps");
        // Spot-check a few entries
        assert!(config.apps.iter().any(|a| a.id == "vscode"));
        assert!(config.apps.iter().any(|a| a.id == "ghostty"));
        assert!(
            config
                .apps
                .iter()
                .any(|a| a.id == "neovim" && a.needs_terminal)
        );
    }

    #[test]
    fn load_apps_config_missing_file_returns_default() {
        // Point at a path that definitely doesn't exist
        let config = load_apps_config_from(Path::new("/tmp/claudette-test-nonexistent/apps.json"));
        assert!(!config.apps.is_empty());
    }

    #[test]
    fn load_apps_config_malformed_file_returns_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("apps.json");
        std::fs::write(&path, "NOT JSON").unwrap();
        let config = load_apps_config_from(&path);
        assert!(!config.apps.is_empty());
    }

    #[test]
    fn detect_finds_executable_in_path() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("myeditor");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let config = AppsConfig {
            apps: vec![AppEntry {
                id: "myeditor".into(),
                name: "My Editor".into(),
                category: AppCategory::Editor,
                bin_names: vec!["myeditor".into()],
                mac_app_names: vec![],
                open_args: vec!["{}".into()],
                needs_terminal: false,
            }],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].id, "myeditor");
        assert_eq!(detected[0].name, "My Editor");
        assert_eq!(detected[0].category, AppCategory::Editor);
        assert_eq!(detected[0].detected_path, bin.to_string_lossy().to_string());
    }

    #[test]
    fn detect_skips_missing_binary() {
        let tmp = tempfile::tempdir().unwrap();
        // No binary created — the directory is empty.
        let config = AppsConfig {
            apps: vec![AppEntry {
                id: "missing".into(),
                name: "Missing App".into(),
                category: AppCategory::Editor,
                bin_names: vec!["nonexistent-binary".into()],
                mac_app_names: vec![],
                open_args: vec!["{}".into()],
                needs_terminal: false,
            }],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert!(detected.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn detect_skips_non_executable_file() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("noexec");
        std::fs::write(&bin, "data").unwrap();
        // Permissions 0o644 — not executable.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();

        let config = AppsConfig {
            apps: vec![AppEntry {
                id: "noexec".into(),
                name: "No Exec".into(),
                category: AppCategory::Editor,
                bin_names: vec!["noexec".into()],
                mac_app_names: vec![],
                open_args: vec!["{}".into()],
                needs_terminal: false,
            }],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert!(detected.is_empty());
    }

    #[test]
    fn detect_sorted_by_category_then_name() {
        let tmp = tempfile::tempdir().unwrap();
        // Create two executables
        for name in ["zterm", "aeditor"] {
            let bin = tmp.path().join(name);
            std::fs::write(&bin, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        let config = AppsConfig {
            apps: vec![
                AppEntry {
                    id: "zterm".into(),
                    name: "Z Terminal".into(),
                    category: AppCategory::Terminal,
                    bin_names: vec!["zterm".into()],
                    mac_app_names: vec![],
                    open_args: vec!["{}".into()],
                    needs_terminal: false,
                },
                AppEntry {
                    id: "aeditor".into(),
                    name: "A Editor".into(),
                    category: AppCategory::Editor,
                    bin_names: vec!["aeditor".into()],
                    mac_app_names: vec![],
                    open_args: vec!["{}".into()],
                    needs_terminal: false,
                },
            ],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert_eq!(detected.len(), 2);
        // Editors come before Terminals (category order: editor, terminal, ide)
        assert_eq!(detected[0].id, "aeditor");
        assert_eq!(detected[1].id, "zterm");
    }
}
