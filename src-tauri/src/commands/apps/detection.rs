use std::path::PathBuf;

use super::model::{AppCategory, AppsConfig, DetectedApp};
use super::platform;

/// Well-known PATH prefixes that macOS GUI apps may not inherit.
const EXTRA_PATH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/sbin"];

/// Build the list of directories to scan for binaries.
fn build_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for dir in EXTRA_PATH_DIRS {
        dirs.push(PathBuf::from(dir));
    }
    let home_dir = dirs::home_dir();
    if let Some(home) = home_dir.as_ref() {
        dirs.push(home.join(".local/bin"));
    }
    dirs.extend(platform::jetbrains_toolbox_script_dirs(home_dir.as_deref()));

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

/// Extensions tried in order on Windows, mirroring PATHEXT semantics
/// closely enough for app detection. `.exe` is probed first so a real
/// executable wins over Bash-style shims (e.g. VS Code's `bin/code`,
/// a no-ext shell script that won't run via `CreateProcess` and isn't
/// `ExtractAssociatedIcon`-friendly). The empty string keeps the legacy
/// behavior of accepting bare-name matches as a last resort, which Unix
/// configs entered into Windows PATH may rely on.
#[cfg(windows)]
const WINDOWS_BIN_EXTS: &[&str] = &[".exe", ".cmd", ".bat", ""];

/// Check whether `name` exists as an executable in any of `path_dirs`.
/// Returns the full path to the first match, or `None`.
pub(super) fn find_binary(name: &str, path_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in path_dirs {
        // On Windows, probe each PATHEXT-style extension before moving
        // to the next directory so a `code.cmd` in dir A wins over a
        // bare-name `code` farther down PATH.
        #[cfg(windows)]
        {
            for ext in WINDOWS_BIN_EXTS {
                let candidate = dir.join(format!("{name}{ext}"));
                let Ok(meta) = std::fs::metadata(&candidate) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                return Some(candidate);
            }
            continue;
        }
        #[cfg(not(windows))]
        {
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
    }
    None
}

/// Detect installed apps from the given config, searching the provided PATH dirs.
/// This is the testable core — `detect_from_config` wraps it with the real PATH.
pub(super) fn detect_with_paths(config: &AppsConfig, path_dirs: &[PathBuf]) -> Vec<DetectedApp> {
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
            let icon_data_url = platform::app_icon_data_url(entry, &bin_path);
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
            .find_map(|name| platform::find_mac_app(name))
        {
            let icon_data_url = platform::app_icon_data_url(entry, &app_path);
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
pub(super) fn detect_from_config(config: &AppsConfig) -> Vec<DetectedApp> {
    let path_dirs = build_path_dirs();
    detect_with_paths(config, &path_dirs)
}
