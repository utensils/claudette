use std::time::Instant;

use futures::stream::{self, StreamExt};
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

/// Look up workspace, repository, and SCM provider override from the database,
/// then reconcile the stored `branch_name` with the worktree's actual branch
/// so the DB remains the source of truth when a branch is renamed externally
/// (e.g. by an agent running `git branch -m`). All DB work happens in
/// synchronous blocks — `rusqlite::Connection` isn't `Send`, so we drop it
/// before the async git call and reopen it for the reconciliation write.
async fn lookup_workspace_context(
    db_path: &std::path::Path,
    workspace_id: &str,
) -> Result<WorkspaceContext, String> {
    let mut ctx = {
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
        WorkspaceContext {
            workspace,
            repo,
            manual_override,
        }
    };

    // Reconcile DB-stored branch_name against the worktree's actual branch.
    // If they differ, sync the DB and use the fresh value going forward.
    // Failures (missing worktree, detached HEAD, etc.) fall back silently to
    // the stored value so SCM lookups still proceed.
    if let Some(worktree) = ctx.workspace.worktree_path.clone()
        && let Ok(actual) = claudette::git::current_branch(&worktree).await
        && actual != ctx.workspace.branch_name
    {
        if let Ok(db) = Database::open(db_path) {
            let _ = db.update_workspace_branch_name(&ctx.workspace.id, &actual);
        }
        ctx.workspace.branch_name = actual;
    }

    Ok(ctx)
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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;

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
                error: entry.error.clone(),
            });
        }
    }

    // Fetch fresh data — run both operations concurrently. Acquire 2
    // permits so the semaphore reflects the true number of in-flight
    // CLI invocations (one for list_pull_requests, one for ci_status).
    let _permit = state
        .scm_semaphore
        .acquire_many(2)
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
        let cached_error = error.clone();
        let mut cache = state.scm_cache.entries.write().await;
        cache.insert(
            cache_key,
            ScmCacheEntry {
                pull_request: pull_request.clone(),
                ci_checks: ci_checks.clone(),
                last_fetched: Instant::now(),
                error: cached_error,
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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;

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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;

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
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;
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
    let ctx = lookup_workspace_context(&app_state.db_path, workspace_id)
        .await
        .ok()?;

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
                error: entry.error.clone(),
            });
        }
    }

    // Two permits because tokio::join! below runs two CLI operations
    // concurrently. One permit per in-flight subprocess.
    let _permit = app_state.scm_semaphore.acquire_many(2).await.ok()?;
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
        let cached_error = error.clone();
        let mut cache = app_state.scm_cache.entries.write().await;
        cache.insert(
            cache_key,
            ScmCacheEntry {
                pull_request: pull_request.clone(),
                ci_checks: ci_checks.clone(),
                last_fetched: Instant::now(),
                error: cached_error,
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

            // All DB reads for this poll cycle in one block.
            // Collect workspace IDs with their repo IDs so we can resolve
            // per-repo archive_on_merge overrides after polling.
            let (workspace_ids, global_archive, per_repo_archive) = {
                let db = match Database::open(&app_state.db_path) {
                    Ok(db) => db,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        continue;
                    }
                };
                let active: Vec<(String, String)> = db
                    .list_workspaces()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|ws| ws.status == claudette::model::WorkspaceStatus::Active)
                    .map(|ws| (ws.id, ws.repository_id))
                    .collect();
                let global = db
                    .get_app_setting("archive_on_merge")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true");
                let repo_ids: std::collections::HashSet<&str> =
                    active.iter().map(|(_, rid)| rid.as_str()).collect();
                let per_repo: std::collections::HashMap<String, bool> = repo_ids
                    .into_iter()
                    .filter_map(|rid| {
                        let key = format!("repo:{rid}:archive_on_merge");
                        let val = db.get_app_setting(&key).ok().flatten()?;
                        if val.is_empty() {
                            return None;
                        }
                        Some((rid.to_string(), val == "true"))
                    })
                    .collect();
                (active, global, per_repo)
            };

            // Poll all workspaces concurrently. The semaphore inside
            // poll_workspace_scm limits actual CLI invocations to 4 at a time.
            let results: Vec<((String, String), Option<ScmDetail>)> = stream::iter(workspace_ids)
                .map(|(ws_id, repo_id)| {
                    let state = &*app_state;
                    async move {
                        let detail = poll_workspace_scm(state, &ws_id).await;
                        ((ws_id, repo_id), detail)
                    }
                })
                .buffer_unordered(8)
                .collect()
                .await;

            for ((ws_id, repo_id), detail) in results {
                if let Some(detail) = detail {
                    let _ = handle.emit("scm-data-updated", &detail);

                    let should_archive = per_repo_archive
                        .get(&repo_id)
                        .copied()
                        .unwrap_or(global_archive);

                    if should_archive
                        && detail.pull_request.as_ref().is_some_and(|pr| {
                            pr.state == claudette::scm_provider::scm::PrState::Merged
                        })
                    {
                        eprintln!("[scm] PR merged for workspace {} — auto-archiving", ws_id);
                        let pr_number = detail.pull_request.as_ref().map(|pr| pr.number);
                        auto_archive_workspace(&handle, &app_state, &ws_id, pr_number).await;
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
    pr_number: Option<u64>,
) {
    // All DB work in a block (Database is not Send — must not hold across .await)
    let archive_info: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        crate::tray::ResolvedSound,
    )> = {
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

        let resolved = crate::tray::resolve_notification(
            &db,
            &app_state.cesp_playback,
            crate::tray::NotificationEvent::Finished,
        );

        // Update DB status
        let _ = db.delete_terminal_tabs_for_workspace(workspace_id);
        let _ = db.update_workspace_status(
            workspace_id,
            &claudette::model::WorkspaceStatus::Archived,
            None,
        );

        Some((
            ws.id.clone(),
            ws.name.clone(),
            ws.worktree_path.clone(),
            repo_path,
            resolved,
        ))
    };

    let Some((ws_id, ws_name, wt_path, repo_path, resolved)) = archive_info else {
        return;
    };

    // Remove worktree (async — must happen outside the DB block)
    if let (Some(wt_path), Some(repo_path)) = (&wt_path, &repo_path) {
        let _ = claudette::git::remove_worktree(repo_path, wt_path, false).await;
    }

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

    let body = match pr_number {
        Some(num) => {
            format!("Workspace \u{2018}{ws_name}\u{2019} archived \u{2014} PR #{num} merged")
        }
        None => format!("Workspace \u{2018}{ws_name}\u{2019} archived \u{2014} PR merged"),
    };
    crate::tray::send_notification(
        handle,
        "",
        "Claudette",
        &body,
        &resolved.sound,
        resolved.volume,
    );

    let mut payload = serde_json::json!({
        "workspace_id": ws_id,
        "workspace_name": ws_name,
    });
    if let Some(num) = pr_number {
        payload["pr_number"] = serde_json::json!(num);
    }
    let _ = handle.emit("workspace-auto-archived", payload);
    eprintln!("[scm] Auto-archived workspace '{ws_name}' ({ws_id})");
}
