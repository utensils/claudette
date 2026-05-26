use serde::{Deserialize, Serialize};

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
    /// `.exe` filenames to walk up to from `detected_path` for icon
    /// extraction on Windows. The npm-shim layouts used by VS Code,
    /// Cursor, etc. put a no-extension bash shim or `.cmd` wrapper in
    /// PATH while the real `.exe` (the one with embedded icon
    /// resources) sits one or more directories above. Setting this to
    /// e.g. `["Code.exe"]` lets Windows builds resolve VS Code's
    /// actual binary for `ExtractAssociatedIcon`. Ignored on other
    /// platforms.
    #[serde(default)]
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub windows_exe_names: Vec<String>,
    /// AppxPackage name (or prefix — `Get-AppxPackage -Name "<value>*"`)
    /// for UWP/MSIX-packaged apps whose real binary sits inside
    /// `%PROGRAMFILES%\WindowsApps` and is reached through a 0-byte
    /// execution alias on PATH (e.g. Windows Terminal's `wt.exe`).
    /// `IShellItemImageFactory` follows the alias to the console
    /// subsystem and returns a generic glyph; the real vendor logo
    /// lives in the package's `Assets/*Logo*.png` files. Setting this
    /// triggers a manifest-aware lookup before the regular
    /// `windows_exe_names` walk-up. Ignored on other platforms.
    #[serde(default)]
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub windows_appx_package: String,
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
    }) && let Some(app) = terminals.clone().find(|app| app.id == preferred_app_id)
    {
        return Some(app.id.clone());
    }

    terminals.map(|app| app.id.clone()).next()
}
