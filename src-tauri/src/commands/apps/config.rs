use std::path::{Path, PathBuf};

use super::model::AppsConfig;

pub(super) const DEFAULT_APPS_JSON: &str = include_str!("../../../default-apps.json");

/// Resolve the path to the user's apps.json config file. Honors
/// `$CLAUDETTE_HOME` via [`claudette::path::claudette_home`].
fn apps_config_path() -> Option<PathBuf> {
    Some(claudette::path::claudette_home().join("apps.json"))
}

/// Merge missing entries from `embedded` into `user` without
/// overwriting any field the user has explicitly set. Two cases:
///
/// - **New entries:** any embedded app whose `id` is absent from
///   `user` is appended verbatim. This lets a Claudette upgrade
///   ship new editor / terminal entries (e.g. Windows Terminal,
///   PowerShell 7) without forcing the user to delete their
///   `apps.json`.
/// - **Backfill new optional fields:** if the user's entry has an
///   empty `mac_app_names` / `windows_exe_names`, copy from the
///   matching embedded entry. These are never user-empty by intent
///   (the field either matters for the platform or doesn't), and
///   skipping them would silently break icon extraction for users
///   whose `apps.json` predates the field being added.
///
/// Anything the user has actually customized — `bin_names`,
/// `open_args`, `name`, `category`, `needs_terminal` — is left
/// untouched.
pub(super) fn merge_missing_default_entries(
    mut user: AppsConfig,
    embedded: AppsConfig,
) -> AppsConfig {
    use std::collections::HashSet;
    let user_ids: HashSet<String> = user.apps.iter().map(|a| a.id.clone()).collect();

    for app in user.apps.iter_mut() {
        let Some(default_entry) = embedded.apps.iter().find(|d| d.id == app.id) else {
            continue;
        };
        if app.mac_app_names.is_empty() && !default_entry.mac_app_names.is_empty() {
            app.mac_app_names = default_entry.mac_app_names.clone();
        }
        if app.windows_exe_names.is_empty() && !default_entry.windows_exe_names.is_empty() {
            app.windows_exe_names = default_entry.windows_exe_names.clone();
        }
        if app.windows_appx_package.is_empty() && !default_entry.windows_appx_package.is_empty() {
            app.windows_appx_package = default_entry.windows_appx_package.clone();
        }
    }

    for default_entry in embedded.apps {
        if !user_ids.contains(&default_entry.id) {
            user.apps.push(default_entry);
        }
    }

    user
}

/// Load and parse apps.json from the given path.
/// If the file doesn't exist, write the embedded default and return it.
/// If the file is malformed, log a warning and return the embedded default.
/// If the file parses, merge in any missing entries / fields from the
/// embedded default so upgrades surface new apps without the user
/// having to delete their config.
pub(super) fn load_apps_config_from(path: &Path) -> AppsConfig {
    let embedded: AppsConfig =
        serde_json::from_str(DEFAULT_APPS_JSON).expect("embedded default-apps.json must be valid");

    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<AppsConfig>(&content) {
                Ok(config) => return merge_missing_default_entries(config, embedded),
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
    embedded
}

/// Public entry point — resolves ~/.claudette/apps.json and loads it.
pub(super) fn load_apps_config() -> AppsConfig {
    match apps_config_path() {
        Some(path) => load_apps_config_from(&path),
        None => serde_json::from_str(DEFAULT_APPS_JSON)
            .expect("embedded default-apps.json must be valid"),
    }
}
