use std::path::{Path, PathBuf};

use super::image::image_data_url_from_file;
use crate::commands::apps::AppEntry;

pub(super) fn jetbrains_toolbox_script_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|home| {
        home.join("Library")
            .join("Application Support")
            .join("JetBrains")
            .join("Toolbox")
            .join("scripts")
    })
    .into_iter()
    .collect()
}

/// Check whether a .app bundle exists in /Applications (macOS only).
pub(super) fn find_mac_app(app_name: &str) -> Option<PathBuf> {
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

fn mac_icon_from_app_bundle(app_path: &Path) -> Option<String> {
    let info_plist = app_path.join("Contents/Info.plist");
    let output = claudette::process::std_command("/usr/libexec/PlistBuddy")
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

    let output = claudette::process::std_command("sips")
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

fn is_app_bundle_path(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "app")
}

pub(super) fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    entry
        .mac_app_names
        .iter()
        .find_map(|name| find_mac_app(name))
        .or_else(|| is_app_bundle_path(detected_path).then(|| detected_path.to_path_buf()))
        .and_then(|app_path| mac_icon_from_app_bundle(&app_path))
}
