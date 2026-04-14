use std::time::Instant;

use serde::Serialize;
use tauri::State;

use claudette::db::Database;
use claudette::plugin::detect;
use claudette::plugin::host_api::WorkspaceInfo;
use claudette::plugin::scm::{CiCheck, PullRequest};

use crate::state::{AppState, ScmCacheEntry};

#[derive(Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub operations: Vec<String>,
    pub cli_available: bool,
    pub remote_patterns: Vec<String>,
}

#[derive(Serialize)]
pub struct ScmDetail {
    pub workspace_id: String,
    pub pull_request: Option<PullRequest>,
    pub ci_checks: Vec<CiCheck>,
    pub provider: Option<String>,
    pub error: Option<String>,
}

/// List all discovered SCM provider plugins.
#[tauri::command]
pub async fn list_plugins(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
    let registry = state.plugins.read().await;
    let plugins = registry
        .plugins
        .values()
        .map(|p| PluginInfo {
            name: p.manifest.name.clone(),
            display_name: p.manifest.display_name.clone(),
            version: p.manifest.version.clone(),
            description: p.manifest.description.clone(),
            operations: p.manifest.operations.clone(),
            cli_available: p.cli_available,
            remote_patterns: p.manifest.remote_patterns.clone(),
        })
        .collect();
    Ok(plugins)
}

/// Get the active SCM provider for a repository (auto-detected or manually overridden).
#[tauri::command]
pub async fn get_scm_provider(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // Do all DB work first (before any .await)
    let (manual_override, repo_path) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let key = format!("repo:{repo_id}:scm_provider");
        let manual = db.get_app_setting(&key).map_err(|e| e.to_string())?;
        let repo = db
            .get_repository(&repo_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        (manual, repo.path)
    };

    if let Some(ref provider) = manual_override
        && !provider.is_empty()
    {
        return Ok(Some(provider.clone()));
    }

    let remote_url = claudette::git::get_remote_url(&repo_path).await.ok();
    if let Some(url) = remote_url {
        let registry = state.plugins.read().await;
        return Ok(detect::detect_provider(&url, &registry.plugins));
    }

    Ok(None)
}

/// Manually set the SCM provider for a repository.
#[tauri::command]
pub async fn set_scm_provider(
    repo_id: String,
    plugin_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let key = format!("repo:{repo_id}:scm_provider");
    db.set_app_setting(&key, &plugin_name)
        .map_err(|e| e.to_string())
}

/// Load full SCM detail (PR + CI checks) for a workspace.
#[tauri::command]
pub async fn load_scm_detail(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<ScmDetail, String> {
    // Do all DB work upfront (Database is not Send)
    let (workspace, repo, manual_override) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let ws = db
            .list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let r = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        let key = format!("repo:{}:scm_provider", r.id);
        let manual = db.get_app_setting(&key).ok().flatten();
        (ws, r, manual)
    };

    // Resolve provider (async — git remote URL lookup)
    let provider_name = resolve_provider_async(&manual_override, &repo.path, &state).await;

    let provider_name = match provider_name {
        Some(name) => name,
        None => {
            return Ok(ScmDetail {
                workspace_id,
                pull_request: None,
                ci_checks: vec![],
                provider: None,
                error: None,
            });
        }
    };

    let ws_info = make_workspace_info(&workspace, &repo);
    let cache_key = (repo.id.clone(), workspace.branch_name.clone());

    // Check cache first
    {
        let cache = state.scm_cache.entries.read().await;
        if let Some(entry) = cache.get(&cache_key)
            && entry.last_fetched.elapsed().as_secs() < 10
        {
            return Ok(ScmDetail {
                workspace_id,
                pull_request: entry.pull_request.clone(),
                ci_checks: entry.ci_checks.clone(),
                provider: Some(provider_name),
                error: entry.error.as_ref().map(|e| e.to_string()),
            });
        }
    }

    // Fetch fresh data
    let _permit = state
        .scm_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let registry = state.plugins.read().await;

    let branch = workspace.branch_name.clone();
    let args = serde_json::json!({"branch": &branch});

    let prs_result = registry
        .call_operation(
            &provider_name,
            "list_pull_requests",
            args.clone(),
            ws_info.clone(),
        )
        .await;

    let ci_result = registry
        .call_operation(&provider_name, "ci_status", args, ws_info)
        .await;

    let mut pull_request: Option<PullRequest> = None;
    let mut ci_checks: Vec<CiCheck> = vec![];
    let mut error: Option<String> = None;

    match prs_result {
        Ok(val) => {
            if let Ok(prs) = serde_json::from_value::<Vec<PullRequest>>(val) {
                pull_request = prs.into_iter().find(|pr| pr.branch == branch);
            }
        }
        Err(e) => {
            error = Some(e.to_string());
        }
    }

    match ci_result {
        Ok(val) => {
            if let Ok(checks) = serde_json::from_value::<Vec<CiCheck>>(val) {
                ci_checks = checks;
            }
        }
        Err(e) => {
            if error.is_none() {
                error = Some(e.to_string());
            }
        }
    }

    // Update cache
    {
        let scm_error = error
            .as_ref()
            .map(|e| claudette::plugin::ScmError::ScriptError(e.clone()));
        let mut cache = state.scm_cache.entries.write().await;
        cache.insert(
            cache_key,
            ScmCacheEntry {
                pull_request: pull_request.clone(),
                ci_checks: ci_checks.clone(),
                last_fetched: Instant::now(),
                error: scm_error,
            },
        );
    }

    Ok(ScmDetail {
        workspace_id,
        pull_request,
        ci_checks,
        provider: Some(provider_name),
        error,
    })
}

/// Create a pull request for a workspace.
#[tauri::command]
pub async fn scm_create_pr(
    workspace_id: String,
    title: String,
    body: String,
    base: String,
    draft: bool,
    state: State<'_, AppState>,
) -> Result<PullRequest, String> {
    let (workspace, repo, manual_override) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let ws = db
            .list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let r = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        let key = format!("repo:{}:scm_provider", r.id);
        let manual = db.get_app_setting(&key).ok().flatten();
        (ws, r, manual)
    };

    let provider = resolve_provider_async(&manual_override, &repo.path, &state)
        .await
        .ok_or("No SCM provider configured for this repository")?;

    let ws_info = make_workspace_info(&workspace, &repo);
    let args = serde_json::json!({
        "title": title,
        "body": body,
        "base": base,
        "branch": workspace.branch_name,
        "draft": draft,
    });

    let _permit = state
        .scm_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let registry = state.plugins.read().await;

    let result = registry
        .call_operation(&provider, "create_pull_request", args, ws_info)
        .await
        .map_err(|e| e.to_string())?;

    // Invalidate cache
    let cache_key = (repo.id.clone(), workspace.branch_name.clone());
    state.scm_cache.entries.write().await.remove(&cache_key);

    serde_json::from_value(result).map_err(|e| e.to_string())
}

/// Merge a pull request.
#[tauri::command]
pub async fn scm_merge_pr(
    workspace_id: String,
    pr_number: u64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (workspace, repo, manual_override) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let ws = db
            .list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let r = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        let key = format!("repo:{}:scm_provider", r.id);
        let manual = db.get_app_setting(&key).ok().flatten();
        (ws, r, manual)
    };

    let provider = resolve_provider_async(&manual_override, &repo.path, &state)
        .await
        .ok_or("No SCM provider configured for this repository")?;

    let ws_info = make_workspace_info(&workspace, &repo);
    let args = serde_json::json!({"number": pr_number});

    let _permit = state
        .scm_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let registry = state.plugins.read().await;

    let result = registry
        .call_operation(&provider, "merge_pull_request", args, ws_info)
        .await
        .map_err(|e| e.to_string())?;

    // Invalidate cache
    let cache_key = (repo.id.clone(), workspace.branch_name.clone());
    state.scm_cache.entries.write().await.remove(&cache_key);

    Ok(result)
}

/// Force refresh SCM data for a workspace.
#[tauri::command]
pub async fn scm_refresh(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<ScmDetail, String> {
    // Invalidate cache
    let cache_key = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let ws = db
            .list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let r = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        (r.id, ws.branch_name)
    };
    state.scm_cache.entries.write().await.remove(&cache_key);

    // Re-fetch
    load_scm_detail(workspace_id, state).await
}

// --- Helpers ---

/// Resolve provider without holding a Database reference across await points.
async fn resolve_provider_async(
    manual_override: &Option<String>,
    repo_path: &str,
    state: &State<'_, AppState>,
) -> Option<String> {
    if let Some(provider) = manual_override
        && !provider.is_empty()
    {
        return Some(provider.clone());
    }

    let remote_url = claudette::git::get_remote_url(repo_path).await.ok()?;
    let registry = state.plugins.read().await;
    detect::detect_provider(&remote_url, &registry.plugins)
}

fn make_workspace_info(
    workspace: &claudette::model::Workspace,
    repo: &claudette::model::Repository,
) -> WorkspaceInfo {
    WorkspaceInfo {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        branch: workspace.branch_name.clone(),
        worktree_path: workspace
            .worktree_path
            .clone()
            .unwrap_or_else(|| repo.path.clone()),
        repo_path: repo.path.clone(),
    }
}
