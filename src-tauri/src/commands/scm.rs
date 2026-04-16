use std::time::Instant;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use claudette::db::Database;
use claudette::scm_provider::detect;
use claudette::scm_provider::host_api::WorkspaceInfo;
use claudette::scm_provider::scm::{CiCheck, PullRequest};

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

/// DB lookup result for workspace + repo + manual provider override.
/// Extracted to avoid repeating this pattern in every command.
struct WorkspaceContext {
    workspace: claudette::model::Workspace,
    repo: claudette::model::Repository,
    manual_override: Option<String>,
}

/// Look up workspace, repository, and SCM provider override from the database.
/// All DB work happens synchronously (Database is not Send).
fn lookup_workspace_context(
    db_path: &std::path::Path,
    workspace_id: &str,
) -> Result<WorkspaceContext, String> {
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let workspace = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let repo = db
        .get_repository(&workspace.repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    let key = format!("repo:{}:scm_provider", repo.id);
    let manual_override = db.get_app_setting(&key).ok().flatten();
    Ok(WorkspaceContext {
        workspace,
        repo,
        manual_override,
    })
}

/// List all discovered SCM provider plugins.
#[tauri::command]
pub async fn list_scm_providers(state: State<'_, AppState>) -> Result<Vec<PluginInfo>, String> {
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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id)?;

    let provider_name =
        match resolve_provider_async(&ctx.manual_override, &ctx.repo.path, &state).await {
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

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());

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

    // Fetch fresh data — run both operations concurrently
    let _permit = state
        .scm_semaphore
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let registry = state.plugins.read().await;

    let branch = ctx.workspace.branch_name.clone();
    let args = serde_json::json!({"branch": &branch});

    let (prs_result, ci_result) = tokio::join!(
        registry.call_operation(
            &provider_name,
            "list_pull_requests",
            args.clone(),
            ws_info.clone(),
        ),
        registry.call_operation(&provider_name, "ci_status", args, ws_info),
    );

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
            .map(|e| claudette::scm_provider::ScmError::ScriptError(e.clone()));
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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id)?;

    let provider = resolve_provider_async(&ctx.manual_override, &ctx.repo.path, &state)
        .await
        .ok_or("No SCM provider configured for this repository")?;

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);
    let args = serde_json::json!({
        "title": title,
        "body": body,
        "base": base,
        "branch": ctx.workspace.branch_name,
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
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());
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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id)?;

    let provider = resolve_provider_async(&ctx.manual_override, &ctx.repo.path, &state)
        .await
        .ok_or("No SCM provider configured for this repository")?;

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);
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
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());
    state.scm_cache.entries.write().await.remove(&cache_key);

    Ok(result)
}

/// Force refresh SCM data for a workspace.
#[tauri::command]
pub async fn scm_refresh(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<ScmDetail, String> {
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id)?;
    let cache_key = (ctx.repo.id, ctx.workspace.branch_name);
    state.scm_cache.entries.write().await.remove(&cache_key);

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

// --- Background polling ---

/// Resolve SCM provider without a Tauri State wrapper (for background tasks).
async fn resolve_provider_for_polling(
    manual_override: &Option<String>,
    repo_path: &str,
    app_state: &AppState,
) -> Option<String> {
    if let Some(provider) = manual_override
        && !provider.is_empty()
    {
        return Some(provider.clone());
    }

    let remote_url = claudette::git::get_remote_url(repo_path).await.ok()?;
    let registry = app_state.plugins.read().await;
    detect::detect_provider(&remote_url, &registry.plugins)
}

/// Fetch SCM data for a single workspace (used by the polling loop).
async fn poll_workspace_scm(app_state: &AppState, workspace_id: &str) -> Option<ScmDetail> {
    let ctx = lookup_workspace_context(&app_state.db_path, workspace_id).ok()?;

    let provider_name =
        resolve_provider_for_polling(&ctx.manual_override, &ctx.repo.path, app_state).await?;

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());

    // Skip if cache is fresh (< 30s for background polling)
    {
        let cache = app_state.scm_cache.entries.read().await;
        if let Some(entry) = cache.get(&cache_key)
            && entry.last_fetched.elapsed().as_secs() < 30
        {
            // Return cached data so frontend still gets populated
            return Some(ScmDetail {
                workspace_id: workspace_id.to_string(),
                pull_request: entry.pull_request.clone(),
                ci_checks: entry.ci_checks.clone(),
                provider: Some(provider_name),
                error: entry.error.as_ref().map(|e| e.to_string()),
            });
        }
    }

    let _permit = app_state.scm_semaphore.acquire().await.ok()?;
    let registry = app_state.plugins.read().await;

    let branch = ctx.workspace.branch_name.clone();
    let args = serde_json::json!({"branch": &branch});

    let (prs_result, ci_result) = tokio::join!(
        registry.call_operation(
            &provider_name,
            "list_pull_requests",
            args.clone(),
            ws_info.clone()
        ),
        registry.call_operation(&provider_name, "ci_status", args, ws_info),
    );

    let mut pull_request: Option<PullRequest> = None;
    let mut ci_checks: Vec<CiCheck> = vec![];
    let mut error: Option<String> = None;

    match prs_result {
        Ok(val) => {
            if let Ok(prs) = serde_json::from_value::<Vec<PullRequest>>(val) {
                pull_request = prs.into_iter().find(|pr| pr.branch == branch);
            }
        }
        Err(e) => error = Some(e.to_string()),
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
            .map(|e| claudette::scm_provider::ScmError::ScriptError(e.clone()));
        let mut cache = app_state.scm_cache.entries.write().await;
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

    Some(ScmDetail {
        workspace_id: workspace_id.to_string(),
        pull_request,
        ci_checks,
        provider: Some(provider_name),
        error,
    })
}

/// Start the background SCM polling loop.
///
/// Runs every 30 seconds, iterating all active workspaces and emitting
/// `scm-data-updated` events to the frontend so sidebar badges and the
/// PR status banner stay fresh without user interaction.
pub fn start_scm_polling(app_handle: tauri::AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        // Small delay to let the app fully initialize
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        loop {
            let app_state = handle.state::<AppState>();

            // Get all active workspace IDs from the database
            let workspace_ids: Vec<String> = {
                let db = match Database::open(&app_state.db_path) {
                    Ok(db) => db,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        continue;
                    }
                };
                db.list_workspaces()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|ws| ws.status == claudette::model::WorkspaceStatus::Active)
                    .map(|ws| ws.id)
                    .collect()
            };

            // Check the archive_on_merge setting once per poll cycle
            let archive_on_merge = {
                Database::open(&app_state.db_path)
                    .ok()
                    .and_then(|db| db.get_app_setting("archive_on_merge").ok().flatten())
                    .as_deref()
                    == Some("true")
            };

            for ws_id in &workspace_ids {
                if let Some(detail) = poll_workspace_scm(&app_state, ws_id).await {
                    let _ = handle.emit("scm-data-updated", &detail);

                    // Auto-archive workspace if PR is merged and setting is enabled
                    if archive_on_merge
                        && detail.pull_request.as_ref().is_some_and(|pr| {
                            pr.state == claudette::scm_provider::scm::PrState::Merged
                        })
                    {
                        eprintln!("[scm] PR merged for workspace {} — auto-archiving", ws_id);
                        auto_archive_workspace(&handle, &app_state, ws_id).await;
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

/// Auto-archive a workspace when its PR is merged.
///
/// Performs the same core steps as the `archive_workspace` Tauri command:
/// removes the worktree, updates the DB status, stops any running agent,
/// and emits a `workspace-auto-archived` event to the frontend.
async fn auto_archive_workspace(
    handle: &tauri::AppHandle,
    app_state: &AppState,
    workspace_id: &str,
) {
    // All DB work in a block (Database is not Send)
    let archive_info: Option<(String, String, Option<String>)> = {
        let db = match Database::open(&app_state.db_path) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("[scm] Failed to open DB for auto-archive: {e}");
                return;
            }
        };
        let ws = db
            .list_workspaces()
            .unwrap_or_default()
            .into_iter()
            .find(|w| w.id == workspace_id);
        let ws = match ws {
            Some(ws) => ws,
            None => return,
        };
        let repo_path = db
            .get_repository(&ws.repository_id)
            .ok()
            .flatten()
            .map(|r| r.path);

        // Remove worktree
        if let (Some(wt_path), Some(repo_path)) = (&ws.worktree_path, &repo_path) {
            let _ = claudette::git::remove_worktree(repo_path, wt_path, false).await;
        }

        // Update DB status
        let _ = db.delete_terminal_tabs_for_workspace(workspace_id);
        let _ = db.update_workspace_status(
            workspace_id,
            &claudette::model::WorkspaceStatus::Archived,
            None,
        );

        Some((ws.id.clone(), ws.name.clone(), ws.worktree_path.clone()))
    };

    let Some((ws_id, ws_name, _)) = archive_info else {
        return;
    };

    // Stop any running agent
    {
        let mut agents = app_state.agents.write().await;
        if let Some(session) = agents.remove(&ws_id)
            && let Some(pid) = session.active_pid
        {
            let _ = claudette::agent::stop_agent(pid).await;
        }
    }

    // Rebuild tray and notify frontend
    crate::tray::rebuild_tray(handle);
    let _ = handle.emit(
        "workspace-auto-archived",
        serde_json::json!({
            "workspace_id": ws_id,
            "workspace_name": ws_name,
        }),
    );
    eprintln!("[scm] Auto-archived workspace '{ws_name}' ({ws_id})");
}
