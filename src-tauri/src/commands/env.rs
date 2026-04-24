//! Tauri commands for the env-provider diagnostic UI.
//!
//! The env-provider system runs silently in the background — every
//! workspace spawn already gets the merged env without asking. These
//! commands expose read + reload surfaces so the UI can tell the user
//! *why* a variable is (or isn't) set, and let them force a
//! re-evaluation (e.g. after running `direnv allow`).
//!
//! Nothing here mutates the workspace or database state — reload just
//! evicts the in-memory cache, and the next spawn/resolve recomputes.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::State;

use claudette::db::Database;

use crate::state::AppState;

/// App-settings key for "is this env-provider enabled for this repo?".
/// Default (absent key) is enabled. `"false"` disables.
fn enabled_key(repo_id: &str, plugin_name: &str) -> String {
    format!("repo:{repo_id}:env_provider:{plugin_name}:enabled")
}

/// Load the set of env-provider plugin names that have been explicitly
/// disabled for a repo. Absent settings = enabled (default), so the
/// returned set contains only names with the setting set to `"false"`.
pub(crate) fn load_disabled_providers(db: &Database, repo_id: &str) -> HashSet<String> {
    // We list all app settings with the repo+env_provider prefix.
    // Pattern is precise; rusqlite does this cheaply via LIKE.
    let prefix = format!("repo:{repo_id}:env_provider:");
    db.list_app_settings_with_prefix(&prefix)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| {
            if value == "false" {
                // key = "repo:{repo_id}:env_provider:{plugin_name}:enabled"
                let rest = key.strip_prefix(&prefix)?;
                let plugin_name = rest.strip_suffix(":enabled")?;
                Some(plugin_name.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Snapshot of one plugin's contribution for a workspace.
///
/// Mirrors [`claudette::env_provider::ResolvedSource`] but uses
/// serializable timestamps (ms since epoch) since `SystemTime` isn't
/// directly serde-friendly across the IPC boundary.
#[derive(Serialize)]
pub struct EnvSourceInfo {
    pub plugin_name: String,
    pub display_name: String,
    pub detected: bool,
    pub enabled: bool,
    pub vars_contributed: usize,
    pub cached: bool,
    /// Milliseconds since the Unix epoch. Frontend formats this
    /// relative to `Date.now()` ("evaluated 3s ago").
    pub evaluated_at_ms: u128,
    pub error: Option<String>,
}

/// Return the list of env-provider plugins that ran (or would run) for
/// this workspace, along with how many vars each contributed and
/// whether the result is cached.
///
/// Side effect: this triggers a full `resolve_for_workspace` pass,
/// which respects the mtime cache — so repeated calls during a quiet
/// period are cheap.
#[tauri::command]
pub async fn get_workspace_env_sources(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<EnvSourceInfo>, String> {
    let (worktree, ws_info, repo_id) = lookup_ws_context(&state, &workspace_id).await?;
    let disabled = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        load_disabled_providers(&db, &repo_id)
    };
    let registry = state.plugins.read().await;
    // Look up display_name for each plugin from the registry so the UI
    // shows "direnv" instead of the internal "env-direnv" name.
    let display_names: std::collections::HashMap<String, String> = registry
        .plugins
        .iter()
        .map(|(name, p)| (name.clone(), p.manifest.display_name.clone()))
        .collect();
    let resolved = claudette::env_provider::resolve_with_registry(
        &registry,
        &state.env_cache,
        Path::new(&worktree),
        &ws_info,
        &disabled,
    )
    .await;

    let sources = resolved
        .sources
        .into_iter()
        .map(|s| {
            let display_name = display_names
                .get(&s.plugin_name)
                .cloned()
                .unwrap_or_else(|| s.plugin_name.clone());
            let enabled = !disabled.contains(&s.plugin_name);
            EnvSourceInfo {
                plugin_name: s.plugin_name,
                display_name,
                detected: s.detected,
                enabled,
                vars_contributed: s.vars_contributed,
                cached: s.cached,
                evaluated_at_ms: s
                    .evaluated_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                error: s.error,
            }
        })
        .collect();
    Ok(sources)
}

/// Toggle whether an env-provider plugin runs for a workspace's repo.
/// Disabling evicts any cached result for every workspace under the
/// repo so the next spawn reflects the change immediately.
#[tauri::command]
pub async fn set_env_provider_enabled(
    workspace_id: String,
    plugin_name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (worktree, _, repo_id) = lookup_ws_context(&state, &workspace_id).await?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let key = enabled_key(&repo_id, &plugin_name);
    // We persist only the "disabled" case; absent key = enabled (default).
    if enabled {
        db.delete_app_setting(&key).map_err(|e| e.to_string())?;
    } else {
        db.set_app_setting(&key, "false")
            .map_err(|e| e.to_string())?;
    }
    // Invalidate the cache entry for this (worktree, plugin) regardless
    // of direction — enabling should re-run the plugin on next resolve,
    // disabling should stop applying a stale cached result.
    state
        .env_cache
        .invalidate(Path::new(&worktree), Some(&plugin_name));
    Ok(())
}

/// Evict the env-provider cache for a workspace, forcing a fresh
/// `export` call on the next spawn / diagnostic query.
///
/// If `plugin_name` is provided, only that plugin's cache entry is
/// dropped. Otherwise every plugin's entry for this worktree is
/// dropped.
#[tauri::command]
pub async fn reload_workspace_env(
    workspace_id: String,
    plugin_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (worktree, _, _) = lookup_ws_context(&state, &workspace_id).await?;
    state
        .env_cache
        .invalidate(Path::new(&worktree), plugin_name.as_deref());
    Ok(())
}

/// Load workspace + repo from the DB and build a [`WorkspaceInfo`] for
/// env-provider invocation. Shared by all commands in this module.
async fn lookup_ws_context(
    state: &AppState,
    workspace_id: &str,
) -> Result<
    (
        String,
        claudette::plugin_runtime::host_api::WorkspaceInfo,
        String,
    ),
    String,
> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let ws = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree = ws
        .worktree_path
        .clone()
        .ok_or("Workspace has no worktree")?;
    let repo = db
        .get_repository(&ws.repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    let repo_id = ws.repository_id.clone();

    let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: ws.id.clone(),
        name: ws.name.clone(),
        branch: ws.branch_name.clone(),
        worktree_path: worktree.clone(),
        repo_path: repo.path,
    };
    Ok((worktree, ws_info, repo_id))
}
