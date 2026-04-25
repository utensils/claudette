//! Tauri commands for the **Plugins** settings section — Claudette's
//! own Lua plugins (SCM + env-provider), not the Claude Code
//! marketplace plugins (those live in `commands/plugin.rs`).
//!
//! Surfaces:
//!   * `list_claudette_plugins` — snapshot of every discovered plugin
//!     with manifest metadata, enabled state, current setting values.
//!   * `set_claudette_plugin_enabled` — global on/off toggle.
//!   * `set_claudette_plugin_setting` — persist a value for one of
//!     the plugin's declared settings fields.
//!   * `reseed_bundled_plugins` — reseed in-binary plugins over any
//!     unmodified on-disk copies. Escape hatch for when users are
//!     stuck on an older seeded `init.lua` because we haven't bumped
//!     `APP_VERSION` yet.
//!
//! Persistence keys in `app_settings`:
//!   * `plugin:{name}:enabled = "false"` — plugin globally disabled.
//!     Absent (or "true") means enabled. We only store the negative
//!     so enabled-by-default stays cheap.
//!   * `plugin:{name}:setting:{key} = <json>` — user override for a
//!     manifest-declared setting field. Stored as JSON so the type
//!     shape (bool/string) round-trips through the `host.config`
//!     surface cleanly.

use serde::Serialize;
use tauri::State;

use claudette::db::Database;
use claudette::plugin_runtime::manifest::{PluginKind, PluginSettingField};

use crate::state::AppState;

#[derive(Serialize)]
pub struct ClaudettePluginInfo {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub kind: PluginKind,
    pub required_clis: Vec<String>,
    pub cli_available: bool,
    pub enabled: bool,
    pub settings_schema: Vec<PluginSettingField>,
    /// Current effective value for each declared setting key (after
    /// merging manifest defaults + user overrides). Null means no
    /// value is set.
    pub setting_values: std::collections::HashMap<String, serde_json::Value>,
}

#[tauri::command]
pub async fn list_claudette_plugins(
    state: State<'_, AppState>,
) -> Result<Vec<ClaudettePluginInfo>, String> {
    let registry = state.plugins.read().await;
    let mut out: Vec<ClaudettePluginInfo> = registry
        .plugins
        .iter()
        .map(|(name, plugin)| {
            let effective = registry.effective_config(name);
            let setting_values: std::collections::HashMap<String, serde_json::Value> = plugin
                .manifest
                .settings
                .iter()
                .map(|field| {
                    let key = field.key().to_string();
                    let value = effective
                        .get(&key)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    (key, value)
                })
                .collect();
            ClaudettePluginInfo {
                name: plugin.manifest.name.clone(),
                display_name: plugin.manifest.display_name.clone(),
                version: plugin.manifest.version.clone(),
                description: plugin.manifest.description.clone(),
                kind: plugin.manifest.kind,
                required_clis: plugin.manifest.required_clis.clone(),
                cli_available: plugin.cli_available,
                enabled: !registry.is_disabled(name),
                settings_schema: plugin.manifest.settings.clone(),
                setting_values,
            }
        })
        .collect();
    // Stable order: by kind first (Scm, EnvProvider), then by name.
    // This matches how the UI groups them.
    out.sort_by(|a, b| {
        (kind_sort_key(a.kind), a.name.as_str()).cmp(&(kind_sort_key(b.kind), b.name.as_str()))
    });
    Ok(out)
}

fn kind_sort_key(kind: PluginKind) -> u8 {
    match kind {
        PluginKind::Scm => 0,
        PluginKind::EnvProvider => 1,
    }
}

/// Globally enable or disable a plugin. Writes to `app_settings` and
/// updates the registry's in-memory state so the change takes effect
/// immediately (next `call_operation` will short-circuit with
/// `PluginDisabled` if disabled).
#[tauri::command]
pub async fn set_claudette_plugin_enabled(
    plugin_name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate the plugin exists before touching the DB — otherwise a
    // typo (or stale UI state) would accumulate stray
    // `plugin:{name}:enabled` rows in `app_settings` that would unexpectedly
    // take effect if a plugin with that name is later installed.
    {
        let registry = state.plugins.read().await;
        if !registry.plugins.contains_key(&plugin_name) {
            return Err(format!("unknown plugin: {plugin_name}"));
        }
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let key = format!("plugin:{plugin_name}:enabled");
    // Persist only the "disabled" case; absent key = enabled.
    if enabled {
        db.delete_app_setting(&key).map_err(|e| e.to_string())?;
    } else {
        db.set_app_setting(&key, "false")
            .map_err(|e| e.to_string())?;
    }
    state
        .plugins
        .read()
        .await
        .set_disabled(&plugin_name, !enabled);
    // Global enable/disable changes can leave stale env-provider exports
    // cached across worktrees. Invalidate any entries for this plugin on
    // BOTH transitions: disabling means stale values must not continue
    // applying, and re-enabling after out-of-band trust changes (e.g.
    // the user ran `direnv allow` while the plugin was off) means the
    // watched-mtime cache key wouldn't catch the change on its own.
    state.env_cache.invalidate_plugin_everywhere(&plugin_name);
    Ok(())
}

/// Persist a user override for one of a plugin's declared settings
/// fields. Pass `value: null` to clear the override (reverts to the
/// manifest default).
#[tauri::command]
pub async fn set_claudette_plugin_setting(
    plugin_name: String,
    key: String,
    value: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let storage_key = format!("plugin:{plugin_name}:setting:{key}");

    let registry = state.plugins.read().await;
    if value.is_null() {
        db.delete_app_setting(&storage_key)
            .map_err(|e| e.to_string())?;
        registry.set_setting(&plugin_name, &key, None);
    } else {
        let serialized = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        db.set_app_setting(&storage_key, &serialized)
            .map_err(|e| e.to_string())?;
        registry.set_setting(&plugin_name, &key, Some(value));
    }

    // Settings can affect future exports (e.g. `auto_allow` turning on
    // means the next export retries with `direnv allow`). Invalidate
    // any env-cache entries whose plugin name matches so the next
    // resolve picks up the new behavior.
    state.env_cache.invalidate_plugin_everywhere(&plugin_name);
    Ok(())
}

/// Reseed all bundled plugins from the in-binary tarball over any
/// unmodified on-disk copies. Skips any plugin whose `init.lua` has
/// been user-modified (hash mismatch). Useful as an escape hatch when
/// we've shipped plugin tree changes between releases and haven't
/// bumped APP_VERSION yet (or for users who want to revert a failed
/// customization).
#[tauri::command]
pub async fn reseed_bundled_plugins(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let registry = state.plugins.read().await;
    let plugin_dir = registry.plugin_dir.clone();
    drop(registry);

    let warnings = claudette::plugin_runtime::seed::reseed_bundled_plugins_force(&plugin_dir);

    // After a reseed, rediscover so the registry picks up any new
    // manifest fields (e.g. settings schemas added between versions).
    // This replaces the registry entirely — setting_overrides are re-
    // hydrated from app_settings below so user preferences survive.
    let new_registry = claudette::plugin_runtime::PluginRegistry::discover(&plugin_dir);
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    if let Ok(entries) = db.list_app_settings_with_prefix("plugin:") {
        for (key, value) in entries {
            let rest = &key["plugin:".len()..];
            if let Some((plugin_name, tail)) = rest.split_once(':') {
                if tail == "enabled" && value == "false" {
                    new_registry.set_disabled(plugin_name, true);
                } else if let Some(setting_key) = tail.strip_prefix("setting:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&value) {
                        new_registry.set_setting(plugin_name, setting_key, Some(v));
                    }
                }
            }
        }
    }
    *state.plugins.write().await = new_registry;

    Ok(warnings)
}

// ---------------------------------------------------------------------------
// Built-in Claudette plugins
// ---------------------------------------------------------------------------
//
// Built-in plugins are Rust-implemented agent surfaces that ship with
// Claudette (currently just `send_to_user`, the in-process MCP tool).
// They live alongside Lua plugins in the settings UI but use a separate
// `builtin_plugin:{name}:enabled` key namespace so the two registries
// don't collide.

#[derive(Serialize)]
pub struct BuiltinPluginInfo {
    pub name: String,
    pub title: String,
    pub description: String,
    pub enabled: bool,
}

#[tauri::command]
pub async fn list_builtin_claudette_plugins(
    state: State<'_, AppState>,
) -> Result<Vec<BuiltinPluginInfo>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let out = claudette::agent_mcp::BUILTIN_PLUGINS
        .iter()
        .map(|p| BuiltinPluginInfo {
            name: p.name.to_string(),
            title: p.title.to_string(),
            description: p.description.to_string(),
            enabled: claudette::agent_mcp::is_builtin_plugin_enabled(&db, p.name),
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn set_builtin_claudette_plugin_enabled(
    plugin_name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !claudette::agent_mcp::BUILTIN_PLUGINS
        .iter()
        .any(|p| p.name == plugin_name)
    {
        return Err(format!("unknown built-in plugin: {plugin_name}"));
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let key = claudette::agent_mcp::builtin_plugin_setting_key(&plugin_name);
    if enabled {
        // Absent key = enabled (matches the Lua-plugin convention).
        db.delete_app_setting(&key).map_err(|e| e.to_string())?;
    } else {
        db.set_app_setting(&key, "false")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
