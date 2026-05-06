use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use tauri::{AppHandle, State};

use claudette::db::Database;
use claudette::plugin::{
    self, BulkPluginUpdateResult, InstalledPlugin, PluginCatalog, PluginConfiguration,
    PluginMarketplace, PluginScope,
};
use serde_json::Value;

use crate::state::AppState;

/// Translate a `claudette::plugin::*` error into a user-facing string,
/// emitting the missing-dependency event when the underlying cause is a
/// missing CLI (issue #641). Mirrors the pattern in `repository.rs` /
/// `scm.rs`.
fn map_plugin_err(app: &AppHandle, err: String) -> String {
    crate::missing_cli::handle_err(app, &err).unwrap_or(err)
}

#[tauri::command]
pub async fn list_plugins(
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<InstalledPlugin>, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::list_installed_plugins(repo_path.as_deref())
        .await
        .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn list_plugin_catalog(
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PluginCatalog, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::list_plugin_catalog(repo_path.as_deref())
        .await
        .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn list_plugin_marketplaces(
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<PluginMarketplace>, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::list_marketplaces(repo_path.as_deref())
        .await
        .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn install_plugin(
    target: String,
    scope: PluginScope,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_non_managed_scope(scope)?;
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    let output = plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_install_args(&target, scope),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))?;
    mark_plugin_sessions_dirty(&state, repo_id.as_deref(), scope).await?;
    Ok(output)
}

#[tauri::command]
pub async fn uninstall_plugin(
    plugin_id: String,
    scope: PluginScope,
    keep_data: Option<bool>,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_non_managed_scope(scope)?;
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    let output = plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_uninstall_args(&plugin_id, scope, keep_data.unwrap_or(false)),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))?;
    plugin::cleanup_plugin_configuration_if_not_installed(&plugin_id)?;
    mark_plugin_sessions_dirty(&state, repo_id.as_deref(), scope).await?;
    Ok(output)
}

#[tauri::command]
pub async fn enable_plugin(
    plugin_id: String,
    scope: PluginScope,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_non_managed_scope(scope)?;
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    let output = plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_enable_args(&plugin_id, scope),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))?;
    mark_plugin_sessions_dirty(&state, repo_id.as_deref(), scope).await?;
    Ok(output)
}

#[tauri::command]
pub async fn disable_plugin(
    plugin_id: String,
    scope: PluginScope,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_non_managed_scope(scope)?;
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    let output = plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_disable_args(&plugin_id, scope),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))?;
    mark_plugin_sessions_dirty(&state, repo_id.as_deref(), scope).await?;
    Ok(output)
}

#[tauri::command]
pub async fn update_plugin(
    plugin_id: String,
    scope: PluginScope,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    let output = plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_update_args(&plugin_id, scope),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))?;
    mark_plugin_sessions_dirty(&state, repo_id.as_deref(), scope).await?;
    Ok(output)
}

#[tauri::command]
pub async fn update_all_plugins(
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BulkPluginUpdateResult, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    let installed = plugin::list_installed_plugins(repo_path.as_deref())
        .await
        .map_err(|e| map_plugin_err(&app, e))?;
    let update_targets = plugin_entries_for_bulk_update(&installed);

    let mut failed = Vec::new();
    let mut succeeded = 0;
    // Per-plugin spawn failures might also be `MISSING_CLI:claude` — route
    // each one through `map_plugin_err` so the missing-dependency event
    // fires (and the sentinel becomes a user-facing string in the bulk
    // result). `handle_err` is cheap and the modal only opens once even if
    // we emit the event multiple times, so we don't need to dedupe here.
    for plugin_entry in &update_targets {
        match plugin::run_claude_plugin_command(
            repo_path.as_deref(),
            &build_update_args(&plugin_entry.plugin_id, plugin_entry.scope),
        )
        .await
        {
            Ok(_) => succeeded += 1,
            Err(error) => failed.push(format!(
                "{} ({}) — {}",
                plugin_entry.plugin_id,
                plugin_entry.scope.as_cli_arg(),
                map_plugin_err(&app, error)
            )),
        }
    }

    if succeeded > 0 {
        let has_global_scope = update_targets
            .iter()
            .any(|plugin| matches!(plugin.scope, PluginScope::Managed | PluginScope::User));
        let has_repo_scope = update_targets
            .iter()
            .any(|plugin| matches!(plugin.scope, PluginScope::Project | PluginScope::Local));

        if has_global_scope {
            mark_plugin_sessions_dirty(&state, None, PluginScope::User).await?;
        }
        if has_repo_scope {
            mark_plugin_sessions_dirty(&state, repo_id.as_deref(), PluginScope::Project).await?;
        }
    }

    Ok(BulkPluginUpdateResult {
        attempted: update_targets.len(),
        succeeded,
        failed,
    })
}

#[tauri::command]
pub async fn add_plugin_marketplace(
    source: String,
    scope: PluginScope,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    require_non_managed_scope(scope)?;
    let repo_path = resolve_scope_repo_path(&state, repo_id.as_deref(), scope)?;
    plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_marketplace_add_args(&source, scope),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn remove_plugin_marketplace(
    name: String,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::run_claude_plugin_command(repo_path.as_deref(), &build_marketplace_remove_args(&name))
        .await
        .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn update_plugin_marketplace(
    name: Option<String>,
    repo_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::run_claude_plugin_command(
        repo_path.as_deref(),
        &build_marketplace_update_args(name.as_deref()),
    )
    .await
    .map_err(|e| map_plugin_err(&app, e))
}

#[tauri::command]
pub async fn load_plugin_configuration(
    plugin_id: String,
    repo_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<PluginConfiguration, String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::load_plugin_configuration(&plugin_id, repo_path.as_deref())
}

#[tauri::command]
pub async fn save_plugin_top_level_configuration(
    plugin_id: String,
    values: BTreeMap<String, Value>,
    repo_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::save_plugin_top_level_configuration(&plugin_id, repo_path.as_deref(), values)?;
    mark_plugin_sessions_dirty(&state, None, PluginScope::User).await
}

#[tauri::command]
pub async fn save_plugin_channel_configuration(
    plugin_id: String,
    server_name: String,
    values: BTreeMap<String, Value>,
    repo_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let repo_path = resolve_optional_repo_path(&state, repo_id.as_deref())?;
    plugin::save_plugin_channel_configuration(
        &plugin_id,
        repo_path.as_deref(),
        &server_name,
        values,
    )?;
    mark_plugin_sessions_dirty(&state, None, PluginScope::User).await
}

fn resolve_optional_repo_path(
    state: &State<'_, AppState>,
    repo_id: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    repo_id
        .map(|repo_id| resolve_repo_path(state, repo_id))
        .transpose()
}

fn resolve_scope_repo_path(
    state: &State<'_, AppState>,
    repo_id: Option<&str>,
    scope: PluginScope,
) -> Result<Option<PathBuf>, String> {
    match scope {
        PluginScope::Project | PluginScope::Local => {
            let repo_id =
                repo_id.ok_or("A local repository is required for project/local scope")?;
            resolve_repo_path(state, repo_id).map(Some)
        }
        PluginScope::Managed | PluginScope::User => resolve_optional_repo_path(state, repo_id),
    }
}

fn resolve_repo_path(state: &State<'_, AppState>, repo_id: &str) -> Result<PathBuf, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(repo_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    Ok(PathBuf::from(repo.path))
}

fn require_non_managed_scope(scope: PluginScope) -> Result<(), String> {
    if scope == PluginScope::Managed {
        Err("Managed scope is not editable in Claudette".to_string())
    } else {
        Ok(())
    }
}

async fn mark_plugin_sessions_dirty(
    state: &State<'_, AppState>,
    repo_id: Option<&str>,
    scope: PluginScope,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo_ids = affected_local_repo_ids(&db, repo_id, scope)?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let affected_workspace_ids: HashSet<String> = workspaces
        .into_iter()
        .filter(|w| repo_ids.contains(&w.repository_id))
        .map(|w| w.id)
        .collect();
    let mut agents = state.agents.write().await;
    for session in agents.values_mut() {
        if affected_workspace_ids.contains(&session.workspace_id) {
            session.mcp_config_dirty = true;
        }
    }
    Ok(())
}

fn affected_local_repo_ids(
    db: &Database,
    repo_id: Option<&str>,
    scope: PluginScope,
) -> Result<HashSet<String>, String> {
    match scope {
        PluginScope::Project | PluginScope::Local => {
            let repo_id =
                repo_id.ok_or("A local repository is required for project/local scope")?;
            Ok(std::iter::once(repo_id.to_string()).collect())
        }
        PluginScope::Managed | PluginScope::User => Ok(db
            .list_repositories()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|repo| repo.id)
            .collect()),
    }
}

fn plugin_entries_for_bulk_update(plugins: &[InstalledPlugin]) -> Vec<&InstalledPlugin> {
    plugins
        .iter()
        .filter(|plugin| plugin.update_available || plugin.latest_known_version.is_none())
        .collect()
}

fn build_install_args(target: &str, scope: PluginScope) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "install".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
        target.to_string(),
    ]
}

fn build_uninstall_args(plugin_id: &str, scope: PluginScope, keep_data: bool) -> Vec<String> {
    let mut args = vec![
        "plugin".to_string(),
        "uninstall".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
    ];
    if keep_data {
        args.push("--keep-data".to_string());
    }
    args.push(plugin_id.to_string());
    args
}

fn build_enable_args(plugin_id: &str, scope: PluginScope) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "enable".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
        plugin_id.to_string(),
    ]
}

fn build_disable_args(plugin_id: &str, scope: PluginScope) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "disable".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
        plugin_id.to_string(),
    ]
}

fn build_update_args(plugin_id: &str, scope: PluginScope) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "update".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
        plugin_id.to_string(),
    ]
}

fn build_marketplace_add_args(source: &str, scope: PluginScope) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "add".to_string(),
        "--scope".to_string(),
        scope.as_cli_arg().to_string(),
        source.to_string(),
    ]
}

fn build_marketplace_remove_args(name: &str) -> Vec<String> {
    vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "remove".to_string(),
        name.to_string(),
    ]
}

fn build_marketplace_update_args(name: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "plugin".to_string(),
        "marketplace".to_string(),
        "update".to_string(),
    ];
    if let Some(name) = name {
        args.push(name.to_string());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_install_command_matches_claude_cli() {
        assert_eq!(
            build_install_args("demo@market", PluginScope::Project),
            vec!["plugin", "install", "--scope", "project", "demo@market"]
        );
    }

    #[test]
    fn build_uninstall_command_supports_keep_data() {
        assert_eq!(
            build_uninstall_args("demo@market", PluginScope::Local, true),
            vec![
                "plugin",
                "uninstall",
                "--scope",
                "local",
                "--keep-data",
                "demo@market",
            ]
        );
    }

    #[test]
    fn build_marketplace_update_command_supports_optional_name() {
        assert_eq!(
            build_marketplace_update_args(None),
            vec!["plugin", "marketplace", "update"]
        );
        assert_eq!(
            build_marketplace_update_args(Some("official")),
            vec!["plugin", "marketplace", "update", "official"]
        );
    }

    #[test]
    fn bulk_update_targets_include_unknown_versions_but_skip_known_current_plugins() {
        let plugins = vec![
            InstalledPlugin {
                channels: Vec::new(),
                command_count: 0,
                description: None,
                enabled: true,
                install_path: "/tmp/needs-update".into(),
                installed_at: None,
                last_updated: None,
                latest_known_version: Some("2.0.0".into()),
                marketplace: Some("official".into()),
                mcp_servers: Vec::new(),
                name: "needs-update".into(),
                plugin_id: "needs-update@official".into(),
                scope: PluginScope::User,
                skill_count: 0,
                update_available: true,
                user_config_schema: BTreeMap::new(),
                version: "1.0.0".into(),
            },
            InstalledPlugin {
                channels: Vec::new(),
                command_count: 0,
                description: None,
                enabled: true,
                install_path: "/tmp/unknown".into(),
                installed_at: None,
                last_updated: None,
                latest_known_version: None,
                marketplace: Some("official".into()),
                mcp_servers: Vec::new(),
                name: "unknown".into(),
                plugin_id: "unknown@official".into(),
                scope: PluginScope::Project,
                skill_count: 0,
                update_available: false,
                user_config_schema: BTreeMap::new(),
                version: "unknown".into(),
            },
            InstalledPlugin {
                channels: Vec::new(),
                command_count: 0,
                description: None,
                enabled: true,
                install_path: "/tmp/current".into(),
                installed_at: None,
                last_updated: None,
                latest_known_version: Some("1.0.0".into()),
                marketplace: Some("official".into()),
                mcp_servers: Vec::new(),
                name: "current".into(),
                plugin_id: "current@official".into(),
                scope: PluginScope::Local,
                skill_count: 0,
                update_available: false,
                user_config_schema: BTreeMap::new(),
                version: "1.0.0".into(),
            },
        ];

        let targets = plugin_entries_for_bulk_update(&plugins);

        assert_eq!(
            targets
                .into_iter()
                .map(|plugin| plugin.plugin_id.as_str())
                .collect::<Vec<_>>(),
            vec!["needs-update@official", "unknown@official"]
        );
    }
}
