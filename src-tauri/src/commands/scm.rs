use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::db::Database;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::plugin_runtime::host_api::WorkspaceInfo;
use claudette::scm::detect;
use claudette::scm::types::{CiCheck, CiCheckStatus, CiFailureLog, CiOverallStatus, PullRequest};

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
            let _ = db.delete_scm_status_cache(&ctx.workspace.id);
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
    let (manual_override, repo_path, default_remote) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let key = format!("repo:{repo_id}:scm_provider");
        let manual = db.get_app_setting(&key).map_err(|e| e.to_string())?;
        let repo = db
            .get_repository(&repo_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        (manual, repo.path, repo.default_remote)
    };

    if let Some(ref provider) = manual_override
        && !provider.is_empty()
    {
        return Ok(Some(provider.clone()));
    }

    let remote_url = claudette::git::get_remote_url(&repo_path, default_remote.as_deref())
        .await
        .ok();
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
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());

    let provider_name = match resolve_provider_async(
        &ctx.manual_override,
        &ctx.repo.path,
        ctx.repo.default_remote.as_deref(),
        &state,
    )
    .await
    {
        Ok(Some(name)) => name,
        Ok(None) => {
            // Confirmed there is no matching provider for this remote (remote
            // URL was readable but no plugin matched). Clear any stale cache
            // row so old badges don't persist when the provider is removed.
            if let Ok(db) = Database::open(&state.db_path) {
                let _ = db.delete_scm_status_cache(&workspace_id);
            }
            state.scm_cache.entries.write().await.remove(&cache_key);
            return Ok(ScmDetail {
                workspace_id,
                pull_request: None,
                ci_checks: vec![],
                provider: None,
                error: None,
            });
        }
        Err(e) => {
            // Provider resolution failed transiently (e.g. `git remote get-url`
            // hiccup). Preserve any previously-cached detail so the UI keeps
            // showing the last-known PR state instead of blanking.
            return Ok(scm_detail_from_previous(
                &workspace_id,
                state.scm_cache.entries.read().await.get(&cache_key),
                None,
                Some(e),
            ));
        }
    };

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);

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

    let outcome = {
        let cache = state.scm_cache.entries.read().await;
        merge_scm_results(prs_result, ci_result, &branch, cache.get(&cache_key))
    };

    let ScmFetchOutcome {
        pull_request,
        ci_checks,
        error,
        should_persist,
    } = outcome;

    if let Some(ref e) = error {
        tracing::warn!(
            target: "claudette::scm",
            workspace_id = %workspace_id,
            branch = %cache_key.1,
            provider = %provider_name,
            error = %e,
            "SCM fetch error"
        );
    }

    if should_persist {
        persist_scm_cache(
            &state.scm_cache,
            &state.db_path,
            ScmCacheKey {
                workspace_id: &workspace_id,
                repo_id: &cache_key.0,
                branch: &cache_key.1,
                provider: &provider_name,
            },
            &pull_request,
            &ci_checks,
            error.clone(),
        )
        .await;
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PullRequest, String> {
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;

    let provider = resolve_provider_async(
        &ctx.manual_override,
        &ctx.repo.path,
        ctx.repo.default_remote.as_deref(),
        &state,
    )
    .await
    .map_err(|e| format!("Failed to resolve SCM provider: {e}"))?
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
        .map_err(|e| {
            let err = e.to_string();
            crate::missing_cli::handle_err(&app, &err).unwrap_or(err)
        })?;

    // Invalidate cache
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());
    state.scm_cache.entries.write().await.remove(&cache_key);
    if let Ok(db) = Database::open(&state.db_path) {
        let _ = db.delete_scm_status_cache(&workspace_id);
    }

    serde_json::from_value(result).map_err(|e| e.to_string())
}

/// Merge a pull request.
#[tauri::command]
pub async fn scm_merge_pr(
    workspace_id: String,
    pr_number: u64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let ctx = lookup_workspace_context(&state.db_path, &workspace_id).await?;

    let provider = resolve_provider_async(
        &ctx.manual_override,
        &ctx.repo.path,
        ctx.repo.default_remote.as_deref(),
        &state,
    )
    .await
    .map_err(|e| format!("Failed to resolve SCM provider: {e}"))?
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
        .map_err(|e| {
            let err = e.to_string();
            crate::missing_cli::handle_err(&app, &err).unwrap_or(err)
        })?;

    // Invalidate cache
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());
    state.scm_cache.entries.write().await.remove(&cache_key);
    if let Ok(db) = Database::open(&state.db_path) {
        let _ = db.delete_scm_status_cache(&workspace_id);
    }

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
    if let Ok(db) = Database::open(&state.db_path) {
        let _ = db.delete_scm_status_cache(&workspace_id);
    }

    load_scm_detail(workspace_id, state).await
}

// --- Helpers ---

/// Resolve provider without holding a Database reference across await points.
///
/// See [`resolve_provider_for_polling`] for the meaning of the three return
/// variants — the contract is identical.
async fn resolve_provider_async(
    manual_override: &Option<String>,
    repo_path: &str,
    default_remote: Option<&str>,
    state: &State<'_, AppState>,
) -> Result<Option<String>, String> {
    if let Some(provider) = manual_override
        && !provider.is_empty()
    {
        return Ok(Some(provider.clone()));
    }

    let remote_url = claudette::git::get_remote_url(repo_path, default_remote)
        .await
        .map_err(|e| e.to_string())?;
    let registry = state.plugins.read().await;
    Ok(detect::detect_provider(&remote_url, &registry.plugins))
}

/// Result of merging fresh plugin call results with a prior cache entry.
struct ScmFetchOutcome {
    pull_request: Option<PullRequest>,
    ci_checks: Vec<CiCheck>,
    error: Option<String>,
    /// `true` when at least one plugin call succeeded and so we have authoritative
    /// new data worth persisting. `false` when both calls errored AND prior
    /// cached data exists — in that case we leave the cache untouched so a
    /// transient outage doesn't clobber known-good state.
    should_persist: bool,
}

/// Merge the results of `list_pull_requests` and `ci_status` plugin calls with
/// the prior cache entry. Pure function — no IO, no async — so it can be unit
/// tested in isolation.
///
/// The key invariant: when a plugin call errors, fall back to the previous
/// cached value for that side. Only return `pull_request: None` (or
/// `ci_checks: vec![]`) when the call succeeded and explicitly reported no
/// data.
fn merge_scm_results(
    prs_result: Result<serde_json::Value, claudette::plugin_runtime::PluginError>,
    ci_result: Result<serde_json::Value, claudette::plugin_runtime::PluginError>,
    branch: &str,
    previous: Option<&ScmCacheEntry>,
) -> ScmFetchOutcome {
    let prs_failed = prs_result.is_err();
    let ci_failed = ci_result.is_err();

    let (pull_request, prs_err) = match prs_result {
        Ok(val) => {
            let parsed = serde_json::from_value::<Vec<PullRequest>>(val)
                .ok()
                .and_then(|prs| prs.into_iter().find(|pr| pr.branch == branch));
            (parsed, None)
        }
        Err(e) => (
            previous.and_then(|p| p.pull_request.clone()),
            Some(e.to_string()),
        ),
    };

    let (ci_checks, ci_err) = match ci_result {
        Ok(val) => (
            serde_json::from_value::<Vec<CiCheck>>(val).unwrap_or_default(),
            None,
        ),
        Err(e) => (
            previous.map(|p| p.ci_checks.clone()).unwrap_or_default(),
            Some(e.to_string()),
        ),
    };

    let error = prs_err.or(ci_err);

    // Skip persistence only when BOTH calls failed AND we have prior cached
    // data to preserve. If either call succeeded we have authoritative new
    // data worth writing; if there's no prior cache there's nothing to
    // clobber, so the empty-with-error row is acceptable.
    let should_persist = !(prs_failed && ci_failed && previous.is_some());

    ScmFetchOutcome {
        pull_request,
        ci_checks,
        error,
        should_persist,
    }
}

/// Build a `ScmDetail` payload from a previously-cached entry, used when the
/// current fetch couldn't run at all (e.g. transient remote-URL lookup
/// failure). Returns an empty detail with the error message when there's no
/// prior entry.
fn scm_detail_from_previous(
    workspace_id: &str,
    previous: Option<&ScmCacheEntry>,
    provider: Option<String>,
    error: Option<String>,
) -> ScmDetail {
    match previous {
        Some(entry) => ScmDetail {
            workspace_id: workspace_id.to_string(),
            pull_request: entry.pull_request.clone(),
            ci_checks: entry.ci_checks.clone(),
            provider,
            error: error.or_else(|| entry.error.clone()),
        },
        None => ScmDetail {
            workspace_id: workspace_id.to_string(),
            pull_request: None,
            ci_checks: vec![],
            provider,
            error,
        },
    }
}

/// Hydrate the in-memory SCM cache from SQLite. Called at polling-task
/// startup so that `merge_scm_results` can see the user's persisted PR/CI
/// state as `previous` on the very first poll after an app restart.
///
/// Errors at any layer are logged and swallowed: a missing or unreadable
/// row just means the in-memory cache stays empty for that key, which is
/// the same state we had before this seed existed.
async fn seed_scm_cache_from_db(db_path: &std::path::Path, cache: &crate::state::ScmCache) {
    let rows = match Database::open(db_path) {
        Ok(db) => match db.load_all_scm_status_cache() {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(target: "claudette::scm", error = %e, "failed to load SCM cache from DB on seed");
                return;
            }
        },
        Err(e) => {
            tracing::warn!(target: "claudette::scm", error = %e, "failed to open DB for SCM cache seed");
            return;
        }
    };

    // Anchor seeded entries far enough in the past that the first poll
    // cycle after restart treats them as stale and triggers a fresh fetch
    // — the SQLite row could be hours old. Falls back to `now()` only on
    // platforms where `Instant` can't represent the past (none in
    // practice on the targets we ship).
    let stale_anchor = Instant::now()
        .checked_sub(std::time::Duration::from_secs(60))
        .unwrap_or_else(Instant::now);

    let mut entries = cache.entries.write().await;
    for row in rows {
        let pull_request = row
            .pr_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Option<PullRequest>>(s).ok())
            .flatten();
        let ci_checks = row
            .ci_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<CiCheck>>(s).ok())
            .unwrap_or_default();
        entries.insert(
            (row.repo_id, row.branch_name),
            ScmCacheEntry {
                pull_request,
                ci_checks,
                last_fetched: stale_anchor,
                error: row.error,
            },
        );
    }
}

/// Identity for a `persist_scm_cache` write — bundles the workspace, repo,
/// branch, and provider names so the helper signature stays under clippy's
/// `too_many_arguments` ceiling.
struct ScmCacheKey<'a> {
    workspace_id: &'a str,
    repo_id: &'a str,
    branch: &'a str,
    provider: &'a str,
}

/// Write the merged SCM data to both the in-memory cache and the SQLite cache.
async fn persist_scm_cache(
    cache: &crate::state::ScmCache,
    db_path: &std::path::Path,
    key: ScmCacheKey<'_>,
    pull_request: &Option<PullRequest>,
    ci_checks: &[CiCheck],
    error: Option<String>,
) {
    let cache_map_key = (key.repo_id.to_string(), key.branch.to_string());
    {
        let mut entries = cache.entries.write().await;
        entries.insert(
            cache_map_key.clone(),
            ScmCacheEntry {
                pull_request: pull_request.clone(),
                ci_checks: ci_checks.to_vec(),
                last_fetched: Instant::now(),
                error: error.clone(),
            },
        );
    }

    match Database::open(db_path) {
        Ok(db) => {
            if let Err(e) = db.upsert_scm_status_cache(&claudette::db::ScmStatusCacheRow {
                workspace_id: key.workspace_id.to_string(),
                repo_id: cache_map_key.0,
                branch_name: cache_map_key.1,
                provider: Some(key.provider.to_string()),
                pr_json: serde_json::to_string(pull_request).ok(),
                ci_json: serde_json::to_string(ci_checks).ok(),
                error,
                fetched_at: String::new(),
            }) {
                tracing::warn!(
                    target: "claudette::scm",
                    workspace_id = %key.workspace_id,
                    error = %e,
                    "failed to persist SCM cache"
                );
            }
        }
        Err(e) => {
            tracing::warn!(target: "claudette::scm", error = %e, "failed to open DB for SCM cache persistence");
        }
    }
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
        repo_id: Some(repo.id.clone()),
    }
}

// --- Background polling ---

/// Resolve SCM provider without a Tauri State wrapper (for background tasks).
///
/// Returns:
/// - `Ok(Some(name))` — provider resolved.
/// - `Ok(None)` — no plugin matches this remote (legitimate: not a recognised
///   forge or no SCM plugins installed).
/// - `Err(e)` — the remote URL lookup itself failed (transient git error). The
///   caller MUST NOT clear cached data in this case.
async fn resolve_provider_for_polling(
    manual_override: &Option<String>,
    repo_path: &str,
    default_remote: Option<&str>,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    if let Some(provider) = manual_override
        && !provider.is_empty()
    {
        return Ok(Some(provider.clone()));
    }

    let remote_url = claudette::git::get_remote_url(repo_path, default_remote)
        .await
        .map_err(|e| e.to_string())?;
    let registry = app_state.plugins.read().await;
    Ok(detect::detect_provider(&remote_url, &registry.plugins))
}

/// Fetch SCM data for a single workspace (used by the polling loop).
async fn poll_workspace_scm(app_state: &AppState, workspace_id: &str) -> Option<ScmDetail> {
    let ctx = lookup_workspace_context(&app_state.db_path, workspace_id)
        .await
        .ok()?;
    let cache_key = (ctx.repo.id.clone(), ctx.workspace.branch_name.clone());

    let provider_name = match resolve_provider_for_polling(
        &ctx.manual_override,
        &ctx.repo.path,
        ctx.repo.default_remote.as_deref(),
        app_state,
    )
    .await
    {
        Ok(Some(name)) => name,
        Ok(None) => {
            // Confirmed no provider for this remote — clear stale cache and
            // return an empty detail so the polling loop emits a clearing
            // scm-data-updated event. Without this, boot-hydrated detail in
            // the frontend is never evicted when a provider is removed, and
            // the PR banner sticks on screen indefinitely.
            if let Ok(db) = Database::open(&app_state.db_path) {
                let _ = db.delete_scm_status_cache(workspace_id);
            }
            app_state.scm_cache.entries.write().await.remove(&cache_key);
            return Some(ScmDetail {
                workspace_id: workspace_id.to_string(),
                pull_request: None,
                ci_checks: vec![],
                provider: None,
                error: None,
            });
        }
        Err(e) => {
            // Transient remote-lookup failure — preserve any prior cached detail
            // so sidebar/banner don't blank out for one polling cycle.
            let cache = app_state.scm_cache.entries.read().await;
            return Some(scm_detail_from_previous(
                workspace_id,
                cache.get(&cache_key),
                None,
                Some(e),
            ));
        }
    };

    let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);

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

    let outcome = {
        let cache = app_state.scm_cache.entries.read().await;
        merge_scm_results(prs_result, ci_result, &branch, cache.get(&cache_key))
    };

    let ScmFetchOutcome {
        pull_request,
        ci_checks,
        error,
        should_persist,
    } = outcome;

    if let Some(ref e) = error {
        tracing::warn!(
            target: "claudette::scm",
            workspace_id = %workspace_id,
            branch = %cache_key.1,
            provider = %provider_name,
            error = %e,
            "SCM poll error"
        );
    }

    if should_persist {
        persist_scm_cache(
            &app_state.scm_cache,
            &app_state.db_path,
            ScmCacheKey {
                workspace_id,
                repo_id: &cache_key.0,
                branch: &cache_key.1,
                provider: &provider_name,
            },
            &pull_request,
            &ci_checks,
            error.clone(),
        )
        .await;
    }

    Some(ScmDetail {
        workspace_id: workspace_id.to_string(),
        pull_request,
        ci_checks,
        provider: Some(provider_name),
        error,
    })
}

/// Seed the per-workspace activity map from the most recent chat-message
/// timestamp on each workspace. Without this, every workspace looks
/// "infinitely idle" after an app restart and would land in the slowest
/// polling tier even if the user was actively working in it five minutes
/// before the restart.
///
/// Errors at any layer are logged and swallowed — a missing seed just
/// means a workspace starts as stale and escalates back into the hot tier
/// on its next selection or agent turn.
async fn seed_workspace_activity_from_db(
    db_path: &std::path::Path,
    activity: &tokio::sync::RwLock<HashMap<String, Instant>>,
) {
    let db = match Database::open(db_path) {
        Ok(db) => db,
        Err(e) => {
            tracing::warn!(target: "claudette::scm", error = %e, "failed to open DB for workspace activity seed");
            return;
        }
    };
    let rows = match db.workspace_last_activity_seconds_ago() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(target: "claudette::scm", error = %e, "workspace activity query failed");
            return;
        }
    };

    let now = Instant::now();
    let mut map = activity.write().await;
    for (workspace_id, seconds_ago) in rows {
        let secs = seconds_ago.max(0) as u64;
        let instant = now.checked_sub(Duration::from_secs(secs)).unwrap_or(now);
        map.insert(workspace_id, instant);
    }
}

/// How often a workspace should be polled, given its current focus and
/// activity state. The smallest interval (30s) matches the outer poll
/// loop's tick rate so the focused workspace polls every tick; longer
/// intervals cause workspaces to be skipped on most ticks.
///
/// Tiers (from `workspace_activity` last-touch timestamp):
/// - **Hot** (30s):  selected, agent running, or active within 1h
/// - **Warm** (5m):  active within 24h
/// - **Cold** (30m): active within 7d
/// - **Stale** (1h): everything older, including never-seen workspaces
fn tier_interval(
    workspace_id: &str,
    selected: Option<&str>,
    agent_running: bool,
    activity: &HashMap<String, Instant>,
) -> Duration {
    if selected == Some(workspace_id) || agent_running {
        return Duration::from_secs(30);
    }
    // No activity entry → treat as fully stale rather than hot, so a fresh
    // app with no chat history doesn't accidentally hammer every workspace.
    let Some(last) = activity.get(workspace_id) else {
        return Duration::from_secs(60 * 60);
    };
    let idle = last.elapsed();
    if idle < Duration::from_secs(60 * 60) {
        Duration::from_secs(30)
    } else if idle < Duration::from_secs(60 * 60 * 24) {
        Duration::from_secs(5 * 60)
    } else if idle < Duration::from_secs(60 * 60 * 24 * 7) {
        Duration::from_secs(30 * 60)
    } else {
        Duration::from_secs(60 * 60)
    }
}

/// Start the background SCM polling loop.
///
/// Ticks every 30s — the smallest tier interval — but only polls each
/// workspace when its tier interval has elapsed since the last successful
/// poll. The focused workspace and workspaces with running agents stay on
/// the 30s cadence; everything else backs off to 5m/30m/1h based on
/// `workspace_activity` recency. See [`tier_interval`].
pub fn start_scm_polling(app_handle: tauri::AppHandle) {
    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        // Hydrate the in-memory cache from SQLite immediately so that the
        // first poll cycle after a restart has access to the user's prior
        // PR/CI state via `merge_scm_results`. Without this seed, a
        // post-restart transient outage would see `previous = None`,
        // overwrite the still-valid SQLite row with `pr_json = "null"`,
        // and reintroduce the disappearing-PR-badge regression.
        {
            let app_state = handle.state::<AppState>();
            seed_scm_cache_from_db(&app_state.db_path, &app_state.scm_cache).await;
            seed_workspace_activity_from_db(&app_state.db_path, &app_state.workspace_activity)
                .await;
        }

        // Small delay to let the app fully initialize
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        loop {
            let app_state = handle.state::<AppState>();

            // All DB reads for this poll cycle in one block.
            // Collect workspace IDs with their repo IDs so we can resolve
            // per-repo archive_on_merge and ci_auto_fix overrides after polling.
            #[allow(clippy::type_complexity)]
            let (
                workspace_ids,
                global_archive,
                per_repo_archive,
                global_ci_auto_fix,
                per_repo_ci_auto_fix,
                ci_auto_fix_prompt,
                ci_auto_fix_cooldown,
                ci_auto_fix_model,
                ci_auto_fix_model_provider,
            ): (
                Vec<(String, String)>,
                bool,
                std::collections::HashMap<String, bool>,
                bool,
                std::collections::HashMap<String, bool>,
                String,
                u64,
                Option<String>,
                Option<String>,
            ) = {
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
                    .iter()
                    .filter_map(|rid| {
                        let key = format!("repo:{rid}:archive_on_merge");
                        let val = db.get_app_setting(&key).ok().flatten()?;
                        if val.is_empty() {
                            return None;
                        }
                        Some((rid.to_string(), val == "true"))
                    })
                    .collect();

                let global_ci = db
                    .get_app_setting("ci_auto_fix_enabled")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("true");
                let per_repo_ci: std::collections::HashMap<String, bool> = repo_ids
                    .into_iter()
                    .filter_map(|rid| {
                        let key = format!("repo:{rid}:ci_auto_fix_enabled");
                        let val = db.get_app_setting(&key).ok().flatten()?;
                        if val.is_empty() {
                            return None;
                        }
                        Some((rid.to_string(), val == "true"))
                    })
                    .collect();
                let prompt = db
                    .get_app_setting("ci_auto_fix_prompt")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| DEFAULT_CI_AUTO_FIX_PROMPT.to_string());
                let cooldown = db
                    .get_app_setting("ci_auto_fix_cooldown_seconds")
                    .ok()
                    .flatten()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(300);
                let model = db
                    .get_app_setting("ci_auto_fix_model")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        db.get_app_setting("default_model")
                            .ok()
                            .flatten()
                            .filter(|s| !s.is_empty())
                    });
                let model_provider = if model.is_some() {
                    db.get_app_setting("ci_auto_fix_model_provider")
                        .ok()
                        .flatten()
                        .filter(|s| !s.is_empty())
                } else {
                    None
                };

                (
                    active,
                    global,
                    per_repo,
                    global_ci,
                    per_repo_ci,
                    prompt,
                    cooldown,
                    model,
                    model_provider,
                )
            };

            // Snapshot the per-tick decision inputs once so all tier
            // checks see a consistent view (no torn reads if a workspace
            // is selected mid-cycle).
            let selected_snapshot = app_state.selected_workspace_id.read().await.clone();
            let activity_snapshot = app_state.workspace_activity.read().await.clone();
            let last_polled_snapshot = app_state.scm_last_polled.read().await.clone();
            let running_workspaces: std::collections::HashSet<String> = {
                let agents = app_state.agents.read().await;
                agents
                    .values()
                    .filter(|s| s.active_pid.is_some())
                    .map(|s| s.workspace_id.clone())
                    .collect()
            };
            let now = Instant::now();

            // Filter down to workspaces that are actually due on this tick.
            let due: Vec<(String, String)> = workspace_ids
                .into_iter()
                .filter(|(ws_id, _)| {
                    let interval = tier_interval(
                        ws_id,
                        selected_snapshot.as_deref(),
                        running_workspaces.contains(ws_id),
                        &activity_snapshot,
                    );
                    match last_polled_snapshot.get(ws_id) {
                        // Never polled in this app run → always due.
                        None => true,
                        Some(last) => now.duration_since(*last) >= interval,
                    }
                })
                .collect();

            if !due.is_empty() {
                tracing::debug!(
                    target: "claudette::scm",
                    due_count = due.len(),
                    selected = selected_snapshot.as_deref().unwrap_or("none"),
                    running_count = running_workspaces.len(),
                    "polling cycle"
                );
            }

            // Poll due workspaces concurrently. The semaphore inside
            // poll_workspace_scm limits actual CLI invocations to 4 at a time.
            let results: Vec<((String, String), Option<ScmDetail>)> = stream::iter(due)
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
                    // Stamp last-polled regardless of whether the poll
                    // returned PR/CI data — even an empty result counts
                    // as a successful "we checked, nothing's there" tick
                    // and should respect the tier cadence.
                    app_state
                        .scm_last_polled
                        .write()
                        .await
                        .insert(ws_id.clone(), Instant::now());

                    let _ = handle.emit("scm-data-updated", &detail);

                    let should_archive = per_repo_archive
                        .get(&repo_id)
                        .copied()
                        .unwrap_or(global_archive);

                    if should_archive
                        && detail
                            .pull_request
                            .as_ref()
                            .is_some_and(|pr| pr.state == claudette::scm::types::PrState::Merged)
                    {
                        tracing::info!(target: "claudette::scm", workspace_id = %ws_id, "PR merged — auto-archiving workspace");
                        let pr_number = detail.pull_request.as_ref().map(|pr| pr.number);
                        auto_archive_workspace(&handle, &app_state, &ws_id, pr_number).await;
                    }

                    // CI auto-fix: detect failure transitions
                    let ci_auto_fix_enabled = per_repo_ci_auto_fix
                        .get(&repo_id)
                        .copied()
                        .unwrap_or(global_ci_auto_fix);

                    if ci_auto_fix_enabled {
                        let current_status =
                            claudette::scm::types::derive_overall_ci_status(&detail.ci_checks);
                        let mut ci_map = app_state.ci_last_status.write().await;
                        let prev = ci_map.get(&ws_id);
                        let prev_status = prev.and_then(|s| s.overall_status.clone());
                        let prev_triggered = prev.and_then(|s| s.last_auto_fix_triggered);

                        let is_failure_transition =
                            is_ci_failure_transition(prev_status.clone(), current_status.clone());

                        let within_cooldown = prev_triggered
                            .is_some_and(|t| t.elapsed().as_secs() < ci_auto_fix_cooldown);

                        // Resolve per-repo prompt override
                        let effective_prompt = Database::open(&app_state.db_path)
                            .ok()
                            .and_then(|db| {
                                let key = format!("repo:{repo_id}:ci_auto_fix_prompt");
                                db.get_app_setting(&key)
                                    .ok()
                                    .flatten()
                                    .filter(|s| !s.is_empty())
                            })
                            .unwrap_or_else(|| ci_auto_fix_prompt.clone());

                        ci_map.insert(
                            ws_id.clone(),
                            crate::state::CiTransitionState {
                                overall_status: current_status,
                                last_auto_fix_triggered: if is_failure_transition
                                    && !within_cooldown
                                {
                                    Some(Instant::now())
                                } else {
                                    prev_triggered
                                },
                            },
                        );
                        drop(ci_map);

                        if is_failure_transition && !within_cooldown {
                            eprintln!(
                                "[scm] CI failure detected for workspace {ws_id} — creating auto-fix session"
                            );
                            auto_create_ci_fix_session(
                                &handle,
                                &app_state,
                                &ws_id,
                                &detail,
                                &effective_prompt,
                                ci_auto_fix_model.as_deref(),
                                ci_auto_fix_model_provider.as_deref(),
                            )
                            .await;
                        }
                    }
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

const DEFAULT_CI_AUTO_FIX_PROMPT: &str = "\
CI has failed on this branch. Please analyze the failures and fix the issues.

## Failed checks
{{failed_checks}}

## Failure logs
{{failure_logs}}

Branch: {{branch}}
PR: {{pr_title}} ({{pr_url}})

Investigate the failing checks, identify the root cause, and make the necessary code changes to fix the CI failures.";

fn format_failed_checks(checks: &[CiCheck]) -> String {
    checks
        .iter()
        .filter(|c| c.status == CiCheckStatus::Failure)
        .map(|c| {
            let url_part = c.url.as_deref().unwrap_or("no URL");
            format!("- **{}**: failure — {}", c.name, url_part)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_all_checks(checks: &[CiCheck]) -> String {
    checks
        .iter()
        .map(|c| {
            let status = match c.status {
                CiCheckStatus::Success => "success",
                CiCheckStatus::Failure => "failure",
                CiCheckStatus::Pending => "pending",
                CiCheckStatus::Cancelled => "cancelled",
                CiCheckStatus::Skipped => "skipped",
            };
            let url_part = c.url.as_deref().unwrap_or("no URL");
            format!("- **{}**: {} — {}", c.name, status, url_part)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_ci_failure_transition(
    previous: Option<CiOverallStatus>,
    current: Option<CiOverallStatus>,
) -> bool {
    matches!(
        (previous, current),
        (Some(prev), Some(CiOverallStatus::Failure)) if prev != CiOverallStatus::Failure
    )
}

fn format_failure_logs(logs: &[CiFailureLog]) -> String {
    if logs.is_empty() {
        return "*(Log fetching not supported by this SCM plugin — check the URLs above for details.)*".to_string();
    }
    logs.iter()
        .map(|l| format!("### {}\n```\n{}\n```", l.check_name, l.log))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn format_ci_auto_fix_prompt(
    template: &str,
    checks: &[CiCheck],
    failure_logs: &[CiFailureLog],
    branch: &str,
    pr: Option<&PullRequest>,
) -> String {
    template
        .replace("{{failed_checks}}", &format_failed_checks(checks))
        .replace("{{all_checks}}", &format_all_checks(checks))
        .replace("{{failure_logs}}", &format_failure_logs(failure_logs))
        .replace("{{branch}}", branch)
        .replace("{{pr_title}}", pr.map(|p| p.title.as_str()).unwrap_or(""))
        .replace("{{pr_url}}", pr.map(|p| p.url.as_str()).unwrap_or(""))
        .replace(
            "{{pr_number}}",
            &pr.map(|p| p.number.to_string()).unwrap_or_default(),
        )
}

async fn auto_create_ci_fix_session(
    handle: &tauri::AppHandle,
    app_state: &AppState,
    workspace_id: &str,
    detail: &ScmDetail,
    prompt_template: &str,
    model: Option<&str>,
    model_provider: Option<&str>,
) {
    let failed_check_names: Vec<String> = detail
        .ci_checks
        .iter()
        .filter(|c| c.status == CiCheckStatus::Failure)
        .map(|c| c.name.clone())
        .collect();

    let mut failure_logs: Vec<CiFailureLog> = Vec::new();

    if let Some(provider) = &detail.provider {
        let ctx = match lookup_workspace_context(&app_state.db_path, workspace_id).await {
            Ok(ctx) => ctx,
            Err(e) => {
                eprintln!("[scm] CI auto-fix: failed to lookup workspace context: {e}");
                return;
            }
        };
        let ws_info = make_workspace_info(&ctx.workspace, &ctx.repo);
        let branch = &ctx.workspace.branch_name;
        let args = serde_json::json!({
            "branch": branch,
            "failed_checks": failed_check_names,
        });

        let registry = app_state.plugins.read().await;
        match registry
            .call_operation(provider, "ci_failure_logs", args, ws_info)
            .await
        {
            Ok(val) => {
                if let Ok(logs) = serde_json::from_value::<Vec<CiFailureLog>>(val) {
                    failure_logs = logs;
                }
            }
            Err(claudette::plugin_runtime::PluginError::OperationNotSupported(_)) => {
                eprintln!(
                    "[scm] CI auto-fix: plugin '{provider}' does not support ci_failure_logs — degrading to check names only"
                );
            }
            Err(e) => {
                eprintln!("[scm] CI auto-fix: failed to fetch failure logs: {e}");
            }
        }
    }

    let branch = detail
        .ci_checks
        .first()
        .and_then(|_| {
            // Re-derive branch from DB for the template
            Database::open(&app_state.db_path).ok().and_then(|db| {
                db.list_workspaces()
                    .ok()?
                    .into_iter()
                    .find(|w| w.id == workspace_id)
                    .map(|w| w.branch_name)
            })
        })
        .unwrap_or_default();

    let prompt = format_ci_auto_fix_prompt(
        prompt_template,
        &detail.ci_checks,
        &failure_logs,
        &branch,
        detail.pull_request.as_ref(),
    );

    let session_id = match Database::open(&app_state.db_path) {
        Ok(db) => match db.create_chat_session(workspace_id) {
            Ok(session) => session.id,
            Err(e) => {
                eprintln!("[scm] CI auto-fix: failed to create session: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("[scm] CI auto-fix: failed to open DB: {e}");
            return;
        }
    };

    let payload = serde_json::json!({
        "workspace_id": workspace_id,
        "session_id": session_id,
        "prompt": prompt,
        "failed_checks": detail.ci_checks.iter()
            .filter(|c| c.status == CiCheckStatus::Failure)
            .collect::<Vec<_>>(),
        "model": model,
        "backend_id": model_provider,
    });

    let _ = handle.emit("ci-auto-fix-session-created", payload);
    eprintln!(
        "[scm] CI auto-fix: created session {session_id} for workspace {workspace_id} ({} failed checks)",
        failed_check_names.len()
    );
}

/// Auto-archive a workspace when its PR is merged.
///
/// Performs the same core steps as the `archive_workspace` Tauri command:
/// removes the worktree, updates the DB status, stops any running agent,
/// and emits a `workspace-auto-archived` event to the frontend.
///
/// When `git_delete_branch_on_archive` is enabled, also deletes the local
/// branch and fully removes the workspace record (preserving lifetime stats)
/// instead of moving it to Archived status.
async fn auto_archive_workspace(
    handle: &tauri::AppHandle,
    app_state: &AppState,
    workspace_id: &str,
    pr_number: Option<u64>,
) {
    // Read-only DB block — capture workspace/repo info and settings.
    // DB mutations are deferred until after async cleanup so the workspace row
    // remains available while worktree removal and agent stop run, and the
    // frozen summary snapshot reflects a fully-quiesced workspace.
    struct ArchiveInfo {
        ws_id: String,
        ws_name: String,
        repo_id: String,
        branch_name: String,
        worktree_path: Option<String>,
        repo_path: Option<String>,
        delete_record: bool,
        resolved: crate::tray::ResolvedSound,
    }
    let archive_info: Option<ArchiveInfo> = {
        let db = match Database::open(&app_state.db_path) {
            Ok(db) => db,
            Err(e) => {
                tracing::warn!(target: "claudette::scm", error = %e, "failed to open DB for auto-archive");
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

        let delete_record = db
            .get_app_setting("git_delete_branch_on_archive")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");

        let resolved = crate::tray::resolve_notification(
            &db,
            &app_state.cesp_playback,
            crate::tray::NotificationEvent::Finished,
        );

        Some(ArchiveInfo {
            ws_id: ws.id.clone(),
            ws_name: ws.name.clone(),
            repo_id: ws.repository_id.clone(),
            branch_name: ws.branch_name.clone(),
            worktree_path: ws.worktree_path.clone(),
            repo_path,
            delete_record,
            resolved,
        })
    };

    let Some(ArchiveInfo {
        ws_id,
        ws_name,
        repo_id,
        branch_name,
        worktree_path: wt_path,
        repo_path,
        delete_record,
        resolved,
    }) = archive_info
    else {
        return;
    };

    // Remove worktree (async — must happen outside the DB block)
    if let (Some(wt_path), Some(repo_path)) = (&wt_path, &repo_path) {
        let _ = claudette::git::remove_worktree(repo_path, wt_path, false).await;
    }

    // Delete the local branch when the setting is enabled.
    if delete_record && let Some(repo_path) = &repo_path {
        let _ = claudette::git::branch_delete(repo_path, &branch_name).await;
    }

    // Stop any running agents for sessions belonging to this workspace.
    // Collect PIDs under the lock, drop the lock, then perform the async
    // process teardowns to avoid stalling other agent operations.
    let pids_to_stop: Vec<u32> = {
        let mut agents = app_state.agents.write().await;
        let to_remove: Vec<String> = agents
            .iter()
            .filter(|(_, s)| s.workspace_id == ws_id)
            .map(|(k, _)| k.clone())
            .collect();
        to_remove
            .into_iter()
            .filter_map(|key| agents.remove(&key).and_then(|s| s.active_pid))
            .collect()
    };
    for pid in pids_to_stop {
        let _ = claudette::agent::stop_agent(pid).await;
    }

    // Now that async cleanup is done, persist the archive/delete mutation.
    // Check the result so we don't emit frontend events for a state change
    // that didn't actually land in the DB.
    let mutation_ok = Database::open(&app_state.db_path)
        .ok()
        .map(|db| {
            if delete_record {
                db.delete_workspace_with_summary(&ws_id).is_ok()
            } else {
                let _ = db.delete_terminal_tabs_for_workspace(&ws_id);
                let _ = db.delete_scm_status_cache(&ws_id);
                db.update_workspace_status(
                    &ws_id,
                    &claudette::model::WorkspaceStatus::Archived,
                    None,
                )
                .is_ok()
            }
        })
        .unwrap_or(false);

    if !mutation_ok {
        tracing::warn!(
            target: "claudette::scm",
            workspace_id = %ws_id,
            workspace_name = %ws_name,
            "DB mutation failed while auto-archiving workspace"
        );
        return;
    }

    let deleted = delete_record;

    // If the workspace record was fully deleted and no workspaces remain for this
    // repo, clean up MCP supervisor state.
    if deleted {
        let supervisor = handle.state::<Arc<McpSupervisor>>();
        let remaining = Database::open(&app_state.db_path)
            .map(|db| db.list_workspaces().unwrap_or_default())
            .unwrap_or_default();
        if !remaining.iter().any(|w| w.repository_id == repo_id) {
            supervisor.remove_repo(&repo_id).await;
            let _ = handle.emit("mcp-status-cleared", &repo_id);
        }
    }

    // Rebuild tray and notify frontend
    crate::tray::rebuild_tray(handle);

    let verb = if deleted { "deleted" } else { "archived" };
    let body = match pr_number {
        Some(num) => {
            format!("Workspace \u{2018}{ws_name}\u{2019} {verb} \u{2014} PR #{num} merged")
        }
        None => format!("Workspace \u{2018}{ws_name}\u{2019} {verb} \u{2014} PR merged"),
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
        "deleted": deleted,
    });
    if let Some(num) = pr_number {
        payload["pr_number"] = serde_json::json!(num);
    }
    let _ = handle.emit("workspace-auto-archived", payload);
    tracing::info!(
        target: "claudette::scm",
        workspace_id = %ws_id,
        workspace_name = %ws_name,
        action = %verb,
        "auto-archived workspace"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudette::plugin_runtime::PluginError;
    use claudette::scm::types::{CiCheckStatus, PrState};

    fn make_pr(branch: &str, number: u64) -> PullRequest {
        PullRequest {
            number,
            title: format!("PR #{number} on {branch}"),
            state: PrState::Open,
            url: format!("https://example.com/pulls/{number}"),
            author: "octocat".into(),
            branch: branch.into(),
            base: "main".into(),
            draft: false,
            ci_status: None,
        }
    }

    fn make_check(name: &str, status: CiCheckStatus) -> CiCheck {
        CiCheck {
            name: name.into(),
            status,
            url: None,
            started_at: None,
        }
    }

    fn make_entry(pr: Option<PullRequest>, checks: Vec<CiCheck>) -> ScmCacheEntry {
        ScmCacheEntry {
            pull_request: pr,
            ci_checks: checks,
            last_fetched: Instant::now(),
            error: None,
        }
    }

    #[test]
    fn preserves_prior_pr_when_list_pull_requests_errors() {
        let prior_pr = make_pr("feature/x", 42);
        let prior = make_entry(Some(prior_pr.clone()), vec![]);
        let fresh_check = make_check("ci/test", CiCheckStatus::Success);

        let outcome = merge_scm_results(
            Err(PluginError::Timeout),
            Ok(serde_json::to_value(vec![fresh_check.clone()]).unwrap()),
            "feature/x",
            Some(&prior),
        );

        assert_eq!(
            outcome.pull_request.as_ref().map(|pr| pr.number),
            Some(prior_pr.number),
            "prior PR should survive a list_pull_requests error",
        );
        assert_eq!(outcome.ci_checks.len(), 1);
        assert_eq!(outcome.ci_checks[0].name, "ci/test");
        assert!(outcome.error.is_some());
        assert!(
            outcome.should_persist,
            "ci_status succeeded so we have new authoritative data to write",
        );
    }

    #[test]
    fn preserves_prior_checks_when_ci_status_errors() {
        let prior_check = make_check("ci/build", CiCheckStatus::Pending);
        let prior = make_entry(None, vec![prior_check.clone()]);
        let fresh_pr = make_pr("feature/y", 7);

        let outcome = merge_scm_results(
            Ok(serde_json::to_value(vec![fresh_pr.clone()]).unwrap()),
            Err(PluginError::Timeout),
            "feature/y",
            Some(&prior),
        );

        assert_eq!(
            outcome.pull_request.as_ref().map(|pr| pr.number),
            Some(fresh_pr.number),
            "fresh PR should be returned",
        );
        assert_eq!(outcome.ci_checks.len(), 1);
        assert_eq!(
            outcome.ci_checks[0].name, prior_check.name,
            "prior checks should survive a ci_status error",
        );
        assert!(outcome.error.is_some());
        assert!(outcome.should_persist);
    }

    #[test]
    fn skips_persistence_when_both_calls_fail_with_prior_cache() {
        let prior = make_entry(
            Some(make_pr("feature/z", 99)),
            vec![make_check("ci/lint", CiCheckStatus::Success)],
        );

        let outcome = merge_scm_results(
            Err(PluginError::Timeout),
            Err(PluginError::Timeout),
            "feature/z",
            Some(&prior),
        );

        assert_eq!(
            outcome.pull_request.as_ref().map(|pr| pr.number),
            Some(99),
            "prior PR preserved",
        );
        assert_eq!(outcome.ci_checks.len(), 1, "prior checks preserved");
        assert!(outcome.error.is_some());
        assert!(
            !outcome.should_persist,
            "both calls failed with prior data — must not clobber the cache",
        );
    }

    #[test]
    fn persists_when_both_calls_fail_without_prior_cache() {
        let outcome = merge_scm_results(
            Err(PluginError::Timeout),
            Err(PluginError::Timeout),
            "feature/new",
            None,
        );

        assert!(outcome.pull_request.is_none());
        assert!(outcome.ci_checks.is_empty());
        assert!(outcome.error.is_some());
        assert!(
            outcome.should_persist,
            "no prior data — writing the empty error row is fine",
        );
    }

    #[test]
    fn clears_pr_when_list_succeeds_and_branch_has_no_match() {
        let prior = make_entry(Some(make_pr("feature/old", 1)), vec![]);

        let outcome = merge_scm_results(
            Ok(serde_json::Value::Array(vec![])),
            Ok(serde_json::Value::Array(vec![])),
            "feature/old",
            Some(&prior),
        );

        assert!(
            outcome.pull_request.is_none(),
            "successful empty response means PR was closed/merged — must clear",
        );
        assert!(outcome.ci_checks.is_empty());
        assert!(outcome.error.is_none());
        assert!(outcome.should_persist);
    }

    #[test]
    fn ignores_pr_for_other_branch() {
        let outcome = merge_scm_results(
            Ok(serde_json::to_value(vec![make_pr("feature/other", 5)]).unwrap()),
            Ok(serde_json::Value::Array(vec![])),
            "feature/mine",
            None,
        );

        assert!(
            outcome.pull_request.is_none(),
            "PRs for other branches must not be selected",
        );
        assert!(outcome.should_persist);
    }

    /// Build a minimal `Repository` fixture for DB tests. We can't reuse
    /// `claudette::db::test_support::make_repo` because it's `pub(crate)`.
    fn fixture_repo(id: &str, path: &str) -> claudette::model::Repository {
        claudette::model::Repository {
            id: id.into(),
            path: path.into(),
            name: id.into(),
            path_slug: id.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        }
    }

    fn fixture_workspace(id: &str, repo_id: &str, branch: &str) -> claudette::model::Workspace {
        claudette::model::Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: id.into(),
            branch_name: branch.into(),
            worktree_path: None,
            status: claudette::model::WorkspaceStatus::Active,
            agent_status: claudette::model::AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
        }
    }

    #[tokio::test]
    async fn seed_hydrates_in_memory_cache_from_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("claudette.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&fixture_repo("r1", "/tmp/repo1"))
            .unwrap();
        db.insert_workspace(&fixture_workspace("w1", "r1", "feature/seed"))
            .unwrap();

        let pr = make_pr("feature/seed", 123);
        let row = claudette::db::ScmStatusCacheRow {
            workspace_id: "w1".into(),
            repo_id: "r1".into(),
            branch_name: "feature/seed".into(),
            provider: Some("github".into()),
            pr_json: serde_json::to_string(&Some(pr)).ok(),
            ci_json: serde_json::to_string(&vec![make_check("ci/build", CiCheckStatus::Success)])
                .ok(),
            error: None,
            fetched_at: String::new(),
        };
        db.upsert_scm_status_cache(&row).unwrap();
        // Drop the synchronous DB handle before the async seed reopens it.
        drop(db);

        let cache = crate::state::ScmCache::new();
        seed_scm_cache_from_db(&db_path, &cache).await;

        let entries = cache.entries.read().await;
        let entry = entries
            .get(&("r1".to_string(), "feature/seed".to_string()))
            .expect("seed should populate the cache from the SQLite row");
        assert_eq!(entry.pull_request.as_ref().map(|pr| pr.number), Some(123));
        assert_eq!(entry.ci_checks.len(), 1);
        assert_eq!(entry.ci_checks[0].name, "ci/build");
        // Seed marks entries stale enough that the first poll triggers a
        // real fetch instead of returning the seeded row as "fresh".
        assert!(
            entry.last_fetched.elapsed().as_secs() >= 30,
            "seeded last_fetched must be older than the 30s polling freshness window",
        );
    }

    #[tokio::test]
    async fn seed_skips_rows_with_null_pr_json() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("claudette.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&fixture_repo("r1", "/tmp/repo1"))
            .unwrap();
        db.insert_workspace(&fixture_workspace("w1", "r1", "feature/none"))
            .unwrap();

        // Row representing "we polled and there's no PR for this branch".
        let row = claudette::db::ScmStatusCacheRow {
            workspace_id: "w1".into(),
            repo_id: "r1".into(),
            branch_name: "feature/none".into(),
            provider: Some("github".into()),
            pr_json: Some("null".into()),
            ci_json: Some("[]".into()),
            error: None,
            fetched_at: String::new(),
        };
        db.upsert_scm_status_cache(&row).unwrap();
        drop(db);

        let cache = crate::state::ScmCache::new();
        seed_scm_cache_from_db(&db_path, &cache).await;

        let entries = cache.entries.read().await;
        let entry = entries
            .get(&("r1".to_string(), "feature/none".to_string()))
            .expect("entry should still be created so subsequent polls see prior state");
        assert!(
            entry.pull_request.is_none(),
            "null pr_json must hydrate as None, not panic",
        );
        assert!(entry.ci_checks.is_empty());
    }

    /// Helper: build an activity map where workspace `ws` was last active
    /// `secs_ago` seconds in the past.
    fn activity_with(ws: &str, secs_ago: u64) -> HashMap<String, Instant> {
        let mut m = HashMap::new();
        let when = Instant::now()
            .checked_sub(Duration::from_secs(secs_ago))
            .unwrap_or_else(Instant::now);
        m.insert(ws.to_string(), when);
        m
    }

    #[test]
    fn tier_selected_is_hot() {
        let activity = activity_with("ws1", 60 * 60 * 24 * 30); // 30 days idle
        assert_eq!(
            tier_interval("ws1", Some("ws1"), false, &activity),
            Duration::from_secs(30),
            "selected workspace must be hot even if activity is ancient",
        );
    }

    #[test]
    fn tier_agent_running_is_hot() {
        let activity = activity_with("ws1", 60 * 60 * 24 * 30);
        assert_eq!(
            tier_interval("ws1", None, true, &activity),
            Duration::from_secs(30),
            "running agent must be hot even if activity is ancient",
        );
    }

    #[test]
    fn tier_recent_activity_under_1h_is_hot() {
        let activity = activity_with("ws1", 60 * 30); // 30 min ago
        assert_eq!(
            tier_interval("ws1", None, false, &activity),
            Duration::from_secs(30),
        );
    }

    #[test]
    fn tier_under_24h_is_warm() {
        let activity = activity_with("ws1", 60 * 60 * 6); // 6h ago
        assert_eq!(
            tier_interval("ws1", None, false, &activity),
            Duration::from_secs(5 * 60),
        );
    }

    #[test]
    fn tier_under_7d_is_cold() {
        let activity = activity_with("ws1", 60 * 60 * 24 * 3); // 3 days ago
        assert_eq!(
            tier_interval("ws1", None, false, &activity),
            Duration::from_secs(30 * 60),
        );
    }

    #[test]
    fn tier_older_than_7d_is_stale() {
        let activity = activity_with("ws1", 60 * 60 * 24 * 30); // 30 days ago
        assert_eq!(
            tier_interval("ws1", None, false, &activity),
            Duration::from_secs(60 * 60),
        );
    }

    #[test]
    fn tier_unknown_workspace_is_stale() {
        let activity: HashMap<String, Instant> = HashMap::new();
        assert_eq!(
            tier_interval("ws1", None, false, &activity),
            Duration::from_secs(60 * 60),
            "workspace with no recorded activity should land in the stale tier, \
             not the hot tier — otherwise a fresh app with empty maps would \
             hammer every workspace on startup",
        );
    }

    #[test]
    fn tier_selected_vs_other_workspace() {
        // A different workspace being selected should not affect ws1's tier.
        let activity = activity_with("ws1", 60 * 60 * 24 * 3); // 3 days
        assert_eq!(
            tier_interval("ws1", Some("ws2"), false, &activity),
            Duration::from_secs(30 * 60),
            "selection of an unrelated workspace must not promote ws1 to hot",
        );
    }
}

#[cfg(test)]
mod ci_auto_fix_tests {
    use super::*;
    use claudette::scm::types::{CiCheck, CiCheckStatus, CiFailureLog, PrState, PullRequest};

    fn make_check(name: &str, status: CiCheckStatus) -> CiCheck {
        CiCheck {
            name: name.to_string(),
            status,
            url: Some(format!("https://ci.example.com/{name}")),
            started_at: None,
        }
    }

    #[test]
    fn format_failed_checks_filters_only_failures() {
        let checks = vec![
            make_check("build", CiCheckStatus::Failure),
            make_check("lint", CiCheckStatus::Success),
            make_check("test", CiCheckStatus::Failure),
        ];
        let result = format_failed_checks(&checks);
        assert!(result.contains("**build**: failure"));
        assert!(result.contains("**test**: failure"));
        assert!(!result.contains("lint"));
    }

    #[test]
    fn format_all_checks_includes_all() {
        let checks = vec![
            make_check("build", CiCheckStatus::Failure),
            make_check("lint", CiCheckStatus::Success),
            make_check("docs", CiCheckStatus::Skipped),
        ];
        let result = format_all_checks(&checks);
        assert!(result.contains("**build**: failure"));
        assert!(result.contains("**lint**: success"));
        assert!(result.contains("**docs**: skipped"));
    }

    #[test]
    fn format_failure_logs_empty_shows_degraded_message() {
        let result = format_failure_logs(&[]);
        assert!(result.contains("not supported"));
    }

    #[test]
    fn format_failure_logs_renders_code_blocks() {
        let logs = vec![CiFailureLog {
            check_name: "build".to_string(),
            log: "error: compilation failed".to_string(),
            url: None,
        }];
        let result = format_failure_logs(&logs);
        assert!(result.contains("### build"));
        assert!(result.contains("error: compilation failed"));
        assert!(result.contains("```"));
    }

    #[test]
    fn format_ci_auto_fix_prompt_substitutes_all_variables() {
        let checks = vec![
            make_check("build", CiCheckStatus::Failure),
            make_check("test", CiCheckStatus::Success),
        ];
        let logs = vec![CiFailureLog {
            check_name: "build".to_string(),
            log: "FAIL".to_string(),
            url: None,
        }];
        let pr = PullRequest {
            number: 42,
            title: "Fix stuff".to_string(),
            state: PrState::Open,
            url: "https://github.com/org/repo/pull/42".to_string(),
            author: "user".to_string(),
            branch: "fix-branch".to_string(),
            base: "main".to_string(),
            draft: false,
            ci_status: Some(CiOverallStatus::Failure),
        };
        let template = "Branch: {{branch}}, PR: {{pr_title}} {{pr_url}} #{{pr_number}}\n{{failed_checks}}\n{{failure_logs}}\n{{all_checks}}";
        let result = format_ci_auto_fix_prompt(template, &checks, &logs, "fix-branch", Some(&pr));
        assert!(result.contains("Branch: fix-branch"));
        assert!(result.contains("PR: Fix stuff"));
        assert!(result.contains("https://github.com/org/repo/pull/42"));
        assert!(result.contains("#42"));
        assert!(result.contains("**build**: failure"));
        assert!(result.contains("### build"));
        assert!(result.contains("**test**: success"));
    }

    #[test]
    fn format_ci_auto_fix_prompt_no_pr() {
        let checks = vec![make_check("build", CiCheckStatus::Failure)];
        let template = "PR: {{pr_title}} ({{pr_url}})";
        let result = format_ci_auto_fix_prompt(template, &checks, &[], "main", None);
        assert_eq!(result, "PR:  ()");
    }

    #[test]
    fn ci_auto_fix_only_triggers_on_observed_transition_to_failure() {
        assert!(!is_ci_failure_transition(
            None,
            Some(CiOverallStatus::Failure),
        ));
        assert!(is_ci_failure_transition(
            Some(CiOverallStatus::Pending),
            Some(CiOverallStatus::Failure),
        ));
        assert!(is_ci_failure_transition(
            Some(CiOverallStatus::Success),
            Some(CiOverallStatus::Failure),
        ));
        assert!(!is_ci_failure_transition(
            Some(CiOverallStatus::Failure),
            Some(CiOverallStatus::Failure),
        ));
        assert!(!is_ci_failure_transition(
            Some(CiOverallStatus::Pending),
            Some(CiOverallStatus::Success),
        ));
    }
}
