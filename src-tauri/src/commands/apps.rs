use std::path::{Path, PathBuf};

// `data_url_from_bytes` (the only consumer of these symbols) is now
// gated to macOS, so the import has to follow.
#[cfg(target_os = "macos")]
use base64::{Engine as _, engine::general_purpose};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

const DEFAULT_APPS_JSON: &str = include_str!("../../default-apps.json");
pub(crate) const DEFAULT_TERMINAL_APP_SETTING_KEY: &str = "default_terminal_app_id";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppCategory {
    Editor,
    FileManager,
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
    /// A platform-resolved application icon as a browser-renderable data URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

pub(crate) fn select_workspace_terminal_app_id(
    detected_apps: &[DetectedApp],
    preferred_app_id: Option<&str>,
) -> Option<String> {
    let terminals = detected_apps
        .iter()
        .filter(|app| app.category == AppCategory::Terminal);

    if let Some(preferred_app_id) = preferred_app_id.and_then(|id| {
        let trimmed = id.trim();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        if let Some(app) = terminals.clone().find(|app| app.id == preferred_app_id) {
            return Some(app.id.clone());
        }
    }

    terminals.map(|app| app.id.clone()).next()
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/// Resolve the path to the user's apps.json config file. Honors
/// `$CLAUDETTE_HOME` via [`claudette::path::claudette_home`].
fn apps_config_path() -> Option<PathBuf> {
    Some(claudette::path::claudette_home().join("apps.json"))
}

/// Load and parse apps.json from the given path.
/// If the file doesn't exist, write the embedded default and return it.
/// If the file is malformed, log a warning and return the embedded default.
fn load_apps_config_from(path: &Path) -> AppsConfig {
    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<AppsConfig>(&content) {
                Ok(config) => return config,
                Err(e) => tracing::warn!(
                    target: "claudette::apps",
                    path = %path.display(),
                    error = %e,
                    "failed to parse apps config"
                ),
            },
            Err(e) => tracing::warn!(
                target: "claudette::apps",
                path = %path.display(),
                error = %e,
                "failed to read apps config"
            ),
        }
    } else {
        // Write the default file for the user to discover and customize.
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(path, DEFAULT_APPS_JSON) {
            tracing::warn!(
                target: "claudette::apps",
                path = %path.display(),
                error = %e,
                "failed to write default apps config"
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
    let roots = [
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices"),
    ];

    if let Some(path) = roots
        .iter()
        .map(|root| root.join(app_name))
        .find(|path| path.exists())
    {
        return Some(path);
    }

    dirs::home_dir()
        .map(|home| home.join("Applications").join(app_name))
        .filter(|path| path.exists())
}

// Only `mac_icon_from_app_bundle` (gated `#[cfg(target_os = "macos")]`)
// uses these helpers — they synthesize data URLs from the icon bytes
// extracted via PlistBuddy/sips. Match the gate so non-macOS builds
// don't trip `dead_code` under -Dwarnings.
#[cfg(target_os = "macos")]
fn data_url_from_bytes(media_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{media_type};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

#[cfg(target_os = "macos")]
fn image_data_url_from_file(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)?;
    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return None,
    };
    let bytes = std::fs::read(path).ok()?;
    Some(data_url_from_bytes(media_type, &bytes))
}

#[cfg(target_os = "macos")]
fn mac_icon_from_app_bundle(app_path: &Path) -> Option<String> {
    let info_plist = app_path.join("Contents/Info.plist");
    let output = std::process::Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIconFile"])
        .arg(&info_plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let icon_name = String::from_utf8(output.stdout).ok()?;
    let icon_name = icon_name.trim();
    if icon_name.is_empty() {
        return None;
    }

    let icon_filename = if Path::new(icon_name).extension().is_some() {
        icon_name.to_owned()
    } else {
        format!("{icon_name}.icns")
    };
    let icon_path = app_path.join("Contents/Resources").join(icon_filename);
    if !icon_path.exists() {
        return None;
    }

    let out_dir = std::env::temp_dir().join(format!(
        "claudette-app-icon-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&out_dir).ok()?;
    let out_file = out_dir.join("icon.png");

    let output = std::process::Command::new("sips")
        .args(["-s", "format", "png"])
        .arg(&icon_path)
        .arg("--out")
        .arg(&out_file)
        .output()
        .ok();

    let icon = output
        .filter(|output| output.status.success())
        .and_then(|_| image_data_url_from_file(&out_file));

    let _ = std::fs::remove_dir_all(&out_dir);
    icon
}

#[cfg(target_os = "macos")]
fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    entry
        .mac_app_names
        .iter()
        .find_map(|name| find_mac_app(name))
        .or_else(|| {
            detected_path
                .ends_with(".app")
                .then(|| detected_path.to_path_buf())
        })
        .and_then(|app_path| mac_icon_from_app_bundle(&app_path))
}

#[cfg(target_os = "linux")]
fn desktop_file_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];

    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }

    dirs
}

#[cfg(target_os = "linux")]
fn parse_desktop_value(contents: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    contents
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "linux")]
fn normalized_match_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(target_os = "linux")]
fn desktop_file_matches(
    entry: &AppEntry,
    detected_path: &Path,
    file_stem: &str,
    contents: &str,
) -> bool {
    let exec = parse_desktop_value(contents, "Exec").unwrap_or_default();
    let name = parse_desktop_value(contents, "Name").unwrap_or_default();
    let detected_name = detected_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    let mut needles = vec![entry.id.as_str(), entry.name.as_str(), detected_name];
    needles.extend(entry.bin_names.iter().map(String::as_str));

    let desktop_key = normalized_match_text(file_stem);
    let name_key = normalized_match_text(&name);
    let exec_key = normalized_match_text(&exec);

    needles.iter().any(|needle| {
        let key = normalized_match_text(needle);
        !key.is_empty()
            && (desktop_key.contains(&key) || name_key.contains(&key) || exec_key.contains(&key))
    })
}

#[cfg(target_os = "linux")]
fn find_linux_desktop_icon_name(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    for dir in desktop_file_dirs() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry_path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            if !entry_path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("desktop"))
            {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&entry_path) else {
                continue;
            };
            let file_stem = entry_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if desktop_file_matches(entry, detected_path, file_stem, &contents) {
                if let Some(icon) = parse_desktop_value(&contents, "Icon") {
                    return Some(icon);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_icon_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/usr/share/pixmaps"),
        PathBuf::from("/usr/share/icons"),
        PathBuf::from("/usr/local/share/icons"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".local/share/icons"));
        roots.push(home.join(".icons"));
    }
    roots
}

#[cfg(target_os = "linux")]
fn icon_candidate_score(path: &Path) -> u8 {
    let text = path.to_string_lossy();
    if text.contains("/64x64/") {
        0
    } else if text.contains("/128x128/") {
        1
    } else if text.contains("/256x256/") {
        2
    } else if text.contains("/scalable/") {
        3
    } else if text.ends_with(".png") {
        4
    } else {
        5
    }
}

#[cfg(target_os = "linux")]
fn find_icon_file_recursive(root: &Path, icon_name: &str, max_depth: usize) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut best: Option<PathBuf> = None;
    let mut visited = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > 12_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            if path.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
                continue;
            }

            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if stem != icon_name {
                continue;
            }
            if image_data_url_from_file(&path).is_none() {
                continue;
            }

            let replace = best
                .as_ref()
                .is_none_or(|current| icon_candidate_score(&path) < icon_candidate_score(current));
            if replace {
                best = Some(path);
            }
        }
    }

    best
}

#[cfg(target_os = "linux")]
fn linux_icon_file_from_name(icon_name: &str) -> Option<PathBuf> {
    let icon_path = PathBuf::from(icon_name);
    if icon_path.is_absolute() && icon_path.exists() {
        return Some(icon_path);
    }

    let direct_names =
        ["png", "svg", "jpg", "jpeg", "webp"].map(|ext| format!("{icon_name}.{ext}"));
    for root in linux_icon_roots() {
        for direct_name in &direct_names {
            let direct = root.join(direct_name);
            if direct.exists() {
                return Some(direct);
            }
        }
        if let Some(path) = find_icon_file_recursive(&root, icon_name, 6) {
            return Some(path);
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    find_linux_desktop_icon_name(entry, detected_path)
        .and_then(|name| linux_icon_file_from_name(&name))
        .and_then(|path| image_data_url_from_file(&path))
}

#[cfg(target_os = "windows")]
fn app_icon_data_url(_entry: &AppEntry, detected_path: &Path) -> Option<String> {
    let script = r#"
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($args[0])
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($stream.ToArray())
"#;

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(script)
        .arg(detected_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let encoded = String::from_utf8(output.stdout).ok()?;
    let encoded = encoded.trim();
    (!encoded.is_empty()).then(|| format!("data:image/png;base64,{encoded}"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn app_icon_data_url(_entry: &AppEntry, _detected_path: &Path) -> Option<String> {
    None
}

/// Detect installed apps from the given config, searching the provided PATH dirs.
/// This is the testable core — `detect_from_config` wraps it with the real PATH.
fn detect_with_paths(config: &AppsConfig, path_dirs: &[PathBuf]) -> Vec<DetectedApp> {
    let category_order = |c: &AppCategory| -> u8 {
        match c {
            AppCategory::Editor => 0,
            AppCategory::FileManager => 1,
            AppCategory::Terminal => 2,
            AppCategory::Ide => 3,
        }
    };

    let mut detected: Vec<(usize, DetectedApp)> = Vec::new();

    for (index, entry) in config.apps.iter().enumerate() {
        // Try bin_names first.
        if let Some(bin_path) = entry
            .bin_names
            .iter()
            .find_map(|name| find_binary(name, path_dirs))
        {
            let icon_data_url = app_icon_data_url(entry, &bin_path);
            detected.push((
                index,
                DetectedApp {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    category: entry.category,
                    detected_path: bin_path.to_string_lossy().to_string(),
                    icon_data_url,
                },
            ));
            continue;
        }

        // Try mac_app_names (macOS only).
        #[cfg(target_os = "macos")]
        if let Some(app_path) = entry
            .mac_app_names
            .iter()
            .find_map(|name| find_mac_app(name))
        {
            let icon_data_url = app_icon_data_url(entry, &app_path);
            detected.push((
                index,
                DetectedApp {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    category: entry.category,
                    detected_path: app_path.to_string_lossy().to_string(),
                    icon_data_url,
                },
            ));
            continue;
        }
    }

    detected.sort_by(|a, b| {
        category_order(&a.1.category)
            .cmp(&category_order(&b.1.category))
            .then_with(|| a.0.cmp(&b.0))
    });

    detected.into_iter().map(|(_, app)| app).collect()
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
async fn open_macos_app(app_name: &str, target_path: &str) -> Result<(), String> {
    tokio::process::Command::new("open")
        .no_console_window()
        .args(["-a", app_name, target_path])
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
        if (count of windows) = 0 then
            create window with default profile command cmd
        else
            tell current window
                set newTab to (create tab with default profile)
                tell current session of newTab
                    write text cmd
                end tell
            end tell
        end if
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
        .no_console_window()
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(worktree_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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

/// Shell-quote a string using single quotes (POSIX-safe).
/// e.g. `hello world` → `'hello world'`, `it's` → `'it'\''s'`
#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Launch a TUI editor via AppleScript when only .app-bundle terminals are available (macOS).
/// Builds a fully shell-quoted command in Rust and passes it as a single argument
/// to avoid injection risks from paths or args with special characters.
#[cfg(target_os = "macos")]
async fn open_tui_via_applescript(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    terminal: &DetectedApp,
) -> Result<(), String> {
    // Build a properly shell-quoted command: cd '<path>' && '<editor>' '<arg1>' '<arg2>' ...
    let mut editor_parts = vec![shell_quote(&editor_detected.detected_path)];
    for arg in &editor_entry.open_args {
        editor_parts.push(shell_quote(&arg.replace("{}", ".")));
    }
    let full_cmd = format!(
        "cd {} && {}",
        shell_quote(worktree_path),
        editor_parts.join(" ")
    );

    let (app_name, script) = if terminal.id == "iterm2" {
        (
            "iTerm",
            r#"on run argv
    set cmd to item 1 of argv
    tell application "iTerm"
        activate
        if (count of windows) = 0 then
            create window with default profile command cmd
        else
            tell current window
                set newTab to (create tab with default profile)
                tell current session of newTab
                    write text cmd
                end tell
            end tell
        end if
    end tell
end run"#,
        )
    } else {
        (
            "Terminal",
            r#"on run argv
    set cmd to item 1 of argv
    tell application "Terminal"
        activate
        do script cmd
    end tell
end run"#,
        )
    };

    tokio::process::Command::new("osascript")
        .no_console_window()
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(&full_cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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
    state: &AppState,
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
    cmd.no_console_window();

    for arg in &terminal_entry.open_args {
        cmd.arg(arg.replace("{}", worktree_path));
    }

    for arg in terminal_exec_args(&terminal.id) {
        cmd.arg(arg);
    }

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

pub(crate) async fn open_workspace_in_app_inner(
    app_id: &str,
    worktree_path: &str,
    state: &AppState,
) -> Result<(), String> {
    // Reload config each time so edits to open_args, needs_terminal, etc. take
    // effect without restart.  Note: the *detected apps list* (which apps appear
    // in the menu) is cached from startup; adding a new app requires restart.
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
        return open_applescript(app_id, worktree_path).await;
    }

    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__open__") {
        tokio::process::Command::new("open")
            .no_console_window()
            .arg(worktree_path)
            .spawn()
            .map_err(|e| format!("Failed to open workspace: {e}"))?;
        return Ok(());
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
        return open_macos_app(&app_path, worktree_path).await;
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
        return open_in_terminal(&entry, &detected, worktree_path, state).await;
    }

    // Handle .app-only detection on macOS (CLI not in PATH).
    #[cfg(target_os = "macos")]
    if detected.detected_path.ends_with(".app") {
        return open_macos_app(&detected.detected_path, worktree_path).await;
    }

    // Normal binary launch: substitute {} in open_args with the worktree path.
    let args: Vec<String> = entry
        .open_args
        .iter()
        .map(|a| a.replace("{}", worktree_path))
        .collect();

    tokio::process::Command::new(&detected.detected_path)
        .no_console_window()
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", entry.name))?;

    Ok(())
}

#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    open_workspace_in_app_inner(&app_id, &worktree_path, state.inner()).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn detected_app(id: &str, name: &str, category: AppCategory) -> DetectedApp {
        DetectedApp {
            id: id.to_string(),
            name: name.to_string(),
            category,
            detected_path: format!("/usr/bin/{id}"),
            icon_data_url: None,
        }
    }

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
    fn parse_file_manager_category() {
        let json = r#"{
            "apps": [{
                "id": "finder",
                "name": "Finder",
                "category": "file_manager",
                "open_args": ["__open__"]
            }]
        }"#;
        let config: AppsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.apps[0].category, AppCategory::FileManager);
    }

    #[test]
    fn select_workspace_terminal_prefers_detected_override() {
        let apps = vec![
            detected_app("vscode", "VS Code", AppCategory::Editor),
            detected_app("terminal", "Terminal", AppCategory::Terminal),
            detected_app("ghostty", "Ghostty", AppCategory::Terminal),
        ];

        assert_eq!(
            select_workspace_terminal_app_id(&apps, Some("ghostty")).as_deref(),
            Some("ghostty")
        );
    }

    #[test]
    fn select_workspace_terminal_ignores_non_terminal_override() {
        let apps = vec![
            detected_app("vscode", "VS Code", AppCategory::Editor),
            detected_app("terminal", "Terminal", AppCategory::Terminal),
        ];

        assert_eq!(
            select_workspace_terminal_app_id(&apps, Some("vscode")).as_deref(),
            Some("terminal")
        );
    }

    #[test]
    fn select_workspace_terminal_uses_first_detected_for_auto() {
        let apps = vec![
            detected_app("vscode", "VS Code", AppCategory::Editor),
            detected_app("iterm2", "iTerm2", AppCategory::Terminal),
            detected_app("ghostty", "Ghostty", AppCategory::Terminal),
        ];

        assert_eq!(
            select_workspace_terminal_app_id(&apps, None).as_deref(),
            Some("iterm2")
        );
    }

    #[test]
    fn select_workspace_terminal_returns_none_without_terminals() {
        let apps = vec![detected_app("vscode", "VS Code", AppCategory::Editor)];

        assert_eq!(
            select_workspace_terminal_app_id(&apps, Some("ghostty")),
            None
        );
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
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("apps.json");
        let config = load_apps_config_from(&path);
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
    fn detect_sorted_by_category_then_config_order() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["zterm", "beditor", "aeditor"] {
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
                    id: "beditor".into(),
                    name: "B Editor".into(),
                    category: AppCategory::Editor,
                    bin_names: vec!["beditor".into()],
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
        assert_eq!(detected.len(), 3);
        assert_eq!(
            detected
                .iter()
                .map(|app| app.id.as_str())
                .collect::<Vec<_>>(),
            vec!["beditor", "aeditor", "zterm"],
        );
    }
}
