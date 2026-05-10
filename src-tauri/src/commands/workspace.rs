use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use claudette::db::Database;
use claudette::fork::{self, ForkInputs};
use claudette::git;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::model::{AgentStatus, ChatMessage, ChatRole, Workspace, WorkspaceStatus};
use claudette::names::NameGenerator;
use claudette::ops::workspace::{self as ops_workspace, CreateParams, SetupResult};
use claudette::ops::{NoopHooks, NotificationEvent, OpsHooks, WorkspaceChangeKind};
// All three platforms call into the trait now: Linux/macOS via
// `.no_console_window()`, Windows via `.new_console_window()` for the
// fallback terminal launchers below.
use claudette::process::CommandWindowExt as _;

use crate::commands::apps::{self, DEFAULT_TERMINAL_APP_SETTING_KEY};
use crate::ops_hooks::TauriHooks;
use crate::state::AppState;

#[derive(Serialize)]
pub struct CreateWorkspaceResult {
    pub workspace: Workspace,
    /// The id of the chat session auto-created alongside the workspace. All
    /// per-conversation state (messages, streaming, tool activities) is keyed
    /// by session id after the multi-session refactor, so callers need this
    /// to post initial system messages (setup script status, etc.) to the
    /// new workspace's chat.
    pub default_session_id: String,
    pub setup_result: Option<SetupResult>,
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state),
    fields(repo_id = %repo_id, workspace_name = %name, skip_setup = skip_setup.unwrap_or(false)),
)]
pub async fn create_workspace(
    repo_id: String,
    name: String,
    skip_setup: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CreateWorkspaceResult, String> {
    create_workspace_inner(
        &repo_id,
        &name,
        skip_setup.unwrap_or(false),
        false,
        &app,
        &state,
    )
    .await
}

/// Shared implementation of the GUI's `create_workspace` command.
///
/// The IPC handler (`src-tauri/src/ipc.rs::handle_create_workspace`)
/// calls this directly so CLI- and remote-driven creates run the same
/// setup-script + env-provider pipeline as the GUI button. Without
/// this, `claudette workspace create` (and `claudette batch run`)
/// would dispatch agent prompts into worktrees that haven't had their
/// `.claudette.json` setup script run.
pub(crate) async fn create_workspace_inner(
    repo_id: &str,
    name: &str,
    skip_setup: bool,
    preserve_supplied_name: bool,
    app: &AppHandle,
    state: &AppState,
) -> Result<CreateWorkspaceResult, String> {
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let (prefix_mode, prefix_custom) = ops_workspace::read_branch_prefix_settings(&db);
    let prefix = ops_workspace::resolve_branch_prefix(&prefix_mode, &prefix_custom).await;
    let worktree_base = state.worktree_base_dir.read().await.clone();

    let params = CreateParams {
        repo_id,
        name,
        branch_prefix: &prefix,
    };
    let out = if preserve_supplied_name {
        ops_workspace::create_preserving_supplied_name(
            &mut db,
            &NoopHooks,
            worktree_base.as_path(),
            params,
        )
        .await
    } else {
        ops_workspace::create(&mut db, &NoopHooks, worktree_base.as_path(), params).await
    }
    .map_err(|e| e.to_string())?;

    // Resolve env-provider output before the workspace is announced to the
    // frontend. That makes a newly-created worktree wait for direnv/mise/etc.
    // warmup (including env-direnv's optional auto-allow) before the user can
    // launch an agent from the normal UI path. Setup scripts reuse the same
    // resolved env below so they run in the exact environment the first agent
    // process will inherit.
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;
    let resolved_env =
        resolve_env_for_workspace(state, &out.workspace, &repo.path, Some(app)).await;

    let setup_result = if skip_setup {
        None
    } else {
        ops_workspace::resolve_and_run_setup(
            &out.workspace,
            Path::new(&repo.path),
            Path::new(&out.worktree_path),
            repo.setup_script.as_deref(),
            repo.base_branch.as_deref(),
            repo.default_remote.as_deref(),
            resolved_env.as_ref(),
        )
        .await
    };

    // The shared op intentionally writes the DB row before env/setup can run,
    // but the GUI should not observe the row until the environment is ready.
    // Emit the lifecycle hook after the warmup/setup phase instead of using
    // TauriHooks inside the op.
    let hooks = TauriHooks::new(app.clone());
    hooks.workspace_changed(&out.workspace.id, WorkspaceChangeKind::Created);
    hooks.notification(NotificationEvent::SessionStart);

    Ok(CreateWorkspaceResult {
        workspace: out.workspace,
        default_session_id: out.default_session_id,
        setup_result,
    })
}

#[derive(Serialize)]
pub struct ForkWorkspaceResult {
    pub workspace: Workspace,
    /// Whether the Claude session JSONL was copied so the fork can `--resume`
    /// its conversation history. When `false`, the fork starts a fresh session.
    pub session_resumed: bool,
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state),
    fields(workspace_id = %workspace_id, checkpoint_id = %checkpoint_id),
)]
pub async fn fork_workspace_at_checkpoint(
    workspace_id: String,
    checkpoint_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ForkWorkspaceResult, String> {
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let (prefix_mode, prefix_custom) = ops_workspace::read_branch_prefix_settings(&db);
    let prefix = ops_workspace::resolve_branch_prefix(&prefix_mode, &prefix_custom).await;

    let worktree_base = state.worktree_base_dir.read().await.clone();

    let outcome = fork::fork_workspace_at_checkpoint(
        &mut db,
        ForkInputs {
            source_workspace_id: &workspace_id,
            checkpoint_id: &checkpoint_id,
            worktree_base: worktree_base.as_path(),
            branch_prefix: &prefix,
            db_path: state.db_path.as_path(),
            now_iso,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let forked_workspace = outcome.workspace.clone();

    #[cfg(feature = "server")]
    {
        if let Some(cfg_arc) = state.share_server_config.read().await.clone() {
            let mut cfg = cfg_arc.lock().await;
            let mut changed = false;
            for share in &mut cfg.shares {
                let includes_source = share
                    .allowed_workspace_ids
                    .iter()
                    .any(|id| id == &workspace_id);
                let includes_fork = share
                    .allowed_workspace_ids
                    .iter()
                    .any(|id| id == &forked_workspace.id);
                if includes_source && !includes_fork {
                    share
                        .allowed_workspace_ids
                        .push(forked_workspace.id.clone());
                    changed = true;
                }
            }
            if changed {
                let _ = cfg.save(&claudette_server::default_config_path());
            }
        }
    }

    state
        .workspace_events
        .publish(claudette::workspace_events::WorkspaceEvent::Forked {
            source_workspace_id: workspace_id.clone(),
            workspace: forked_workspace.clone(),
        });

    crate::tray::rebuild_tray(&app);

    Ok(ForkWorkspaceResult {
        workspace: forked_workspace,
        session_resumed: outcome.session_resumed,
    })
}

#[tauri::command]
pub async fn run_workspace_setup(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<SetupResult>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?;

    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == ws.repository_id)
        .ok_or("Repository not found")?;

    let resolved_env = resolve_env_for_workspace(&state, ws, &repo.path, Some(&app)).await;
    let result = ops_workspace::resolve_and_run_setup(
        ws,
        Path::new(&repo.path),
        Path::new(worktree_path),
        repo.setup_script.as_deref(),
        repo.base_branch.as_deref(),
        repo.default_remote.as_deref(),
        resolved_env.as_ref(),
    )
    .await;

    Ok(result)
}

/// Resolve the env-provider layer for a workspace, producing a
/// [`claudette::env_provider::ResolvedEnv`] merged from all detected
/// providers (direnv, mise, dotenv, nix-devshell).
///
/// When `app` is `Some`, per-plugin progress is emitted as
/// `workspace_env_progress` Tauri events so the sidebar / chat
/// composer / terminal overlay can render the loading state. The
/// archive path passes `None` because there is no UI to show progress
/// to once the workspace is being torn down.
///
/// Returns `None` when the workspace has no worktree path yet (which
/// shouldn't happen by the time we're about to spawn, but keeps the
/// call sites defensive).
async fn resolve_env_for_workspace(
    state: &AppState,
    ws: &Workspace,
    repo_path: &str,
    app: Option<&AppHandle>,
) -> Option<claudette::env_provider::ResolvedEnv> {
    let worktree = ws.worktree_path.as_deref()?;
    let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: ws.id.clone(),
        name: ws.name.clone(),
        branch: ws.branch_name.clone(),
        worktree_path: worktree.to_string(),
        repo_path: repo_path.to_string(),
        repo_id: Some(ws.repository_id.clone()),
    };
    let disabled = Database::open(&state.db_path)
        .map(|db| crate::commands::env::load_disabled_providers(&db, &ws.repository_id))
        .unwrap_or_default();
    // Snapshot — workspace creation runs the env-provider resolve
    // inline (the setup script needs the resolved env), and that
    // resolve can run ~120s. Holding the outer RwLock that long
    // stalls the Plugins settings page; see `plugins_snapshot`.
    let registry = state.plugins_snapshot().await;
    let progress =
        app.map(|h| crate::commands::env::TauriEnvProgressSink::new(h.clone(), ws.id.clone()));
    let resolved = claudette::env_provider::resolve_with_registry_and_progress(
        &registry,
        &state.env_cache,
        Path::new(worktree),
        &ws_info,
        &disabled,
        progress
            .as_ref()
            .map(|p| p as &dyn claudette::env_provider::EnvProgressSink),
    )
    .await;
    crate::commands::env::register_resolved_with_watcher(
        state,
        Path::new(worktree),
        &resolved.sources,
    )
    .await;
    Some(resolved)
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state, supervisor),
    fields(workspace_id = %id, skip_archive_script = skip_archive_script.unwrap_or(false)),
)]
pub async fn archive_workspace(
    id: String,
    skip_archive_script: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<bool, String> {
    let out = archive_workspace_inner(
        &id,
        None,
        skip_archive_script.unwrap_or(false),
        &app,
        &state,
        &supervisor,
    )
    .await?;
    Ok(out.delete_branch)
}

/// Result of the shared archive helper. Tauri command discards everything
/// except `delete_branch`; the IPC handler returns the full struct so
/// CLI clients see the same response shape they'd get from the WS server.
pub(crate) struct ArchiveWorkspaceOutput {
    pub delete_branch: bool,
    pub branch_deleted: bool,
    pub was_last_workspace: bool,
    pub worktree_path: Option<String>,
    pub repository_id: String,
    pub archive_result: Option<SetupResult>,
}

/// Shared implementation of the GUI's `archive_workspace` command.
///
/// The IPC handler (`src-tauri/src/ipc.rs::handle_archive_workspace`)
/// calls this directly so CLI- and remote-driven archives perform the
/// same agent teardown, env-watcher cleanup, and MCP supervisor
/// shutdown the GUI does. Without this, an in-flight agent could keep
/// running against a worktree that was just removed and `state.agents`
/// would accumulate ghost entries.
///
/// `delete_branch_override` lets non-GUI callers force the delete-branch
/// behavior per request — `claudette workspace archive --delete-branch`
/// must work even when the user has `git_delete_branch_on_archive`
/// disabled in the GUI settings. `None` falls back to the saved setting.
pub(crate) async fn archive_workspace_inner(
    id: &str,
    delete_branch_override: Option<bool>,
    skip_archive_script: bool,
    app: &AppHandle,
    state: &AppState,
    supervisor: &McpSupervisor,
) -> Result<ArchiveWorkspaceOutput, String> {
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // The user-visible "delete branch on archive" setting lives in app
    // settings; we read it sync before the op so we can pass the boolean
    // through cleanly without the op needing DB access for settings.
    // CLI/IPC callers can override this per-call via `delete_branch_override`.
    let delete_branch = match delete_branch_override {
        Some(b) => b,
        None => {
            db.get_app_setting("git_delete_branch_on_archive")
                .ok()
                .flatten()
                .as_deref()
                == Some("true")
        }
    };

    // Stop any in-flight agent processes before mutating DB state. Agent
    // tracking lives in AppState (not the shared ops layer), so this part
    // stays here. Collect PIDs + session IDs under the lock, then stop
    // outside it to avoid blocking unrelated requests.
    let (ended_sids, pids_to_stop): (Vec<String>, Vec<u32>) = {
        let mut agents = state.agents.write().await;
        let to_remove: Vec<String> = agents
            .iter()
            .filter(|(_, s)| s.workspace_id == id)
            .map(|(k, _)| k.clone())
            .collect();
        let mut sids = Vec::new();
        let mut pids = Vec::new();
        for key in to_remove {
            if let Some(session) = agents.remove(&key) {
                if !session.session_id.is_empty() {
                    sids.push(session.session_id);
                }
                if let Some(pid) = session.active_pid {
                    pids.push(pid);
                }
            }
        }
        (sids, pids)
    };
    for pid in pids_to_stop {
        let _ = claudette::agent::stop_agent(pid).await;
    }
    for sid in &ended_sids {
        let _ = db.end_agent_session(sid, true);
    }

    // Resolve and run the archive script before removing the worktree so it
    // still has filesystem access. Best-effort: failure logs to chat but
    // does not block the archive. The frontend gates this via
    // `archive_script_auto_run` + a confirmation modal — when the user
    // declines, it passes `skip_archive_script: true` and the script is
    // bypassed entirely.
    let archive_result: Option<SetupResult> = if skip_archive_script {
        None
    } else {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let repos = db.list_repositories().map_err(|e| e.to_string())?;
        let ws_opt = workspaces.iter().find(|w| w.id == id);
        let repo_opt = ws_opt.and_then(|ws| repos.iter().find(|r| r.id == ws.repository_id));
        match (ws_opt, repo_opt) {
            (Some(ws), Some(repo)) => {
                if let Some(ref wt_path) = ws.worktree_path {
                    // Archive teardown: no UI is observing the
                    // workspace anymore, so skip progress events.
                    let resolved_env = resolve_env_for_workspace(state, ws, &repo.path, None).await;
                    let result = ops_workspace::resolve_and_run_archive(
                        ws,
                        Path::new(&repo.path),
                        Path::new(wt_path),
                        repo.archive_script.as_deref(),
                        repo.base_branch.as_deref(),
                        repo.default_remote.as_deref(),
                        resolved_env.as_ref(),
                    )
                    .await;
                    if let Some(ref r) = result
                        && let Ok(Some(session_id)) = db.default_session_id_for_workspace(id)
                    {
                        let label = if r.source == "repo" {
                            ".claudette.json"
                        } else {
                            "settings"
                        };
                        let status = if r.timed_out {
                            "timed out"
                        } else if r.success {
                            "completed"
                        } else {
                            "failed"
                        };
                        let content = if r.output.is_empty() {
                            format!("Archive script ({label}) {status}")
                        } else {
                            format!("Archive script ({label}) {status}:\n{}", r.output)
                        };
                        let msg = ChatMessage {
                            id: uuid::Uuid::new_v4().to_string(),
                            workspace_id: id.to_string(),
                            chat_session_id: session_id,
                            role: ChatRole::System,
                            content,
                            cost_usd: None,
                            duration_ms: None,
                            created_at: now_iso(),
                            thinking: None,
                            input_tokens: None,
                            output_tokens: None,
                            cache_read_tokens: None,
                            cache_creation_tokens: None,
                            author_participant_id: None,
                            author_display_name: None,
                        };
                        if let Err(err) = db.insert_chat_message(&msg) {
                            tracing::warn!(
                                target: "claudette::workspace",
                                phase = "archive",
                                error = %err,
                                "failed to post archive script result to chat"
                            );
                        } else {
                            let _ = app.emit("chat-system-message", &msg);
                        }
                    }
                    result
                } else {
                    None
                }
            }
            _ => None,
        }
    };

    let out = ops_workspace::archive(
        &mut db,
        TauriHooks::new(app.clone()).as_ref(),
        ops_workspace::ArchiveParams {
            workspace_id: id,
            delete_branch,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Drop env-provider watches + cache entries rooted at the now-defunct
    // worktree. Lives outside the op because the watcher is `AppState`-
    // scoped — the op can't reach it without taking a dep on Tauri state.
    if let Some(ref wt_path) = out.worktree_path {
        if let Some(watcher) = state.env_watcher.read().await.as_ref() {
            watcher.unregister(Path::new(wt_path), None);
        }
        state.env_cache.invalidate(Path::new(wt_path), None);
    }

    // Repo-scoped MCP supervisor cleanup when the last workspace for the
    // repo is gone. Only relevant when the workspace row was hard-deleted
    // (delete_branch path) — Archived rows keep the repo "alive" for
    // potential restore.
    if delete_branch && out.was_last_workspace {
        supervisor.remove_repo(&out.repository_id).await;
        let _ = app.emit("mcp-status-cleared", &out.repository_id);
    }

    // Notify connected remotes so they remove the workspace from their
    // sidebar live, instead of waiting for the next reconnect to filter
    // it out. The forwarder in `claudette-server::ws` filters by the
    // connection's allowed-workspaces scope before delivering.
    state
        .workspace_events
        .publish(claudette::workspace_events::WorkspaceEvent::Archived {
            workspace_id: id.to_string(),
        });

    crate::tray::rebuild_tray(app);

    Ok(ArchiveWorkspaceOutput {
        delete_branch,
        branch_deleted: out.branch_deleted,
        was_last_workspace: out.was_last_workspace,
        worktree_path: out.worktree_path,
        repository_id: out.repository_id,
        archive_result,
    })
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state),
    fields(workspace_id = %id),
)]
pub async fn restore_workspace(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("Workspace not found")?;

    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == ws.repository_id)
        .ok_or("Repository not found")?;

    let worktree_base = state.worktree_base_dir.read().await;
    let worktree_path: PathBuf = worktree_base.join(&repo.path_slug).join(&ws.name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let actual_path = git::restore_worktree(&repo.path, &ws.branch_name, &worktree_path_str)
        .await
        .map_err(|e| e.to_string())?;

    db.update_workspace_status(&id, &WorkspaceStatus::Active, Some(&actual_path))
        .map_err(|e| e.to_string())?;

    crate::tray::rebuild_tray(&app);

    Ok(actual_path)
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state, supervisor),
    fields(workspace_id = %id),
)]
pub async fn delete_workspace(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let Some(ws) = workspaces.iter().find(|w| w.id == id) else {
        return Ok(());
    };

    let repo_id = ws.repository_id.clone();

    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos.iter().find(|r| r.id == repo_id);

    // Stop any running agents and clear sessions so tray state stays consistent.
    // Collect PIDs under the lock, then stop processes outside it.
    let pids_to_stop: Vec<u32> = {
        let mut agents = state.agents.write().await;
        let to_remove: Vec<String> = agents
            .iter()
            .filter(|(_, s)| s.workspace_id == id)
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

    if let Some(repo) = repo {
        // Remove worktree if active.
        if let Some(ref wt_path) = ws.worktree_path {
            let _ = git::remove_worktree(&repo.path, wt_path, true).await;
        }

        // Best-effort branch delete. Force-deletes even if unmerged commits exist.
        let _ = git::branch_delete(&repo.path, &ws.branch_name).await;
    }

    // Drop any env-provider watch + cache entry rooted at this
    // workspace's worktree. Keeps OS watch count bounded across
    // workspace churn and prevents invalidation events for a path
    // Claudette no longer knows about.
    if let Some(ref wt_path) = ws.worktree_path {
        if let Some(watcher) = state.env_watcher.read().await.as_ref() {
            watcher.unregister(Path::new(wt_path), None);
        }
        state.env_cache.invalidate(Path::new(wt_path), None);
    }

    // Cascade deletes chat messages and terminal tabs. Materializes a frozen
    // summary row into `deleted_workspace_summaries` in the same transaction so
    // lifetime dashboard stats survive the cascade.
    db.delete_workspace_with_summary(&id)
        .map_err(|e| e.to_string())?;

    // If this was the last workspace for the repo, clean up MCP supervisor state
    // and notify the frontend to clear the stale MCP status indicator.
    let remaining = db.list_workspaces().unwrap_or_default();
    if !remaining.iter().any(|w| w.repository_id == repo_id) {
        supervisor.remove_repo(&repo_id).await;
        let _ = app.emit("mcp-status-cleared", &repo_id);
    }

    crate::tray::rebuild_tray(&app);

    Ok(())
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::workspace",
    skip(app, state),
    fields(workspace_id = %id, new_name = %new_name),
)]
pub async fn rename_workspace(
    id: String,
    new_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let trimmed = new_name.trim().to_string();
    if !is_valid_workspace_name(&trimmed) {
        return Err("Invalid workspace name. Use letters, numbers, and hyphens only.".into());
    }
    if trimmed.len() > 60 {
        return Err("Workspace name must be 60 characters or fewer".into());
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_workspace_name(&id, &trimmed).map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            "A workspace with this name already exists in this repository".into()
        } else {
            e.to_string()
        }
    })?;

    crate::tray::rebuild_tray(&app);

    Ok(())
}

#[derive(Serialize)]
pub struct GeneratedWorkspaceName {
    /// Safe for branch names and file paths
    pub slug: String,
    /// Fun display version (may contain emojis/special chars for easter eggs)
    pub display: String,
    /// Optional easter egg message
    pub message: Option<String>,
}

#[tauri::command]
pub fn generate_workspace_name() -> GeneratedWorkspaceName {
    let generated = NameGenerator::new().generate();
    let message = match &generated.easter_egg {
        Some(claudette::names::EasterEgg::Message(msg)) => Some(msg.clone()),
        _ => None,
    };
    GeneratedWorkspaceName {
        slug: generated.slug(),
        display: generated.display,
        message,
    }
}

/// Reassign per-repository `sort_order` of workspaces in the given repo to
/// match the supplied id sequence. Mirrors `reorder_repositories` but scoped
/// per-repo because workspaces live inside a specific repo's worktree on
/// disk and only ever reorder among siblings (option 2A — within-repo only).
#[tauri::command]
pub async fn reorder_workspaces(
    repository_id: String,
    workspace_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.reorder_workspaces(&repository_id, &workspace_ids)
        .map_err(|e| e.to_string())
}

/// Re-read the current branch for every active workspace. Returns one
/// `(workspace_id, current_branch)` entry per workspace we could probe
/// (level-triggered: every active workspace, not just ones that drifted),
/// so the frontend store can self-heal if it has somehow diverged from the
/// DB. See issue #538. Drift is still persisted to the DB on diff, so
/// external renames (`git branch -m`, `git checkout -b`, …) made from the
/// integrated terminal flow back into SQLite as well.
#[tauri::command]
pub async fn refresh_branches(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    claudette::workspace_sync::reconcile_all_workspace_branches(&state.db_path).await
}

/// Re-read the current branch for a single workspace, persist any change,
/// and return the current branch (`Some`) — always the live git value, not
/// just on drift, so the caller can overwrite its store unconditionally
/// (#538). `None` means we have nothing authoritative to publish: the
/// workspace is archived, has no worktree path, or git couldn't name a
/// branch (e.g. detached HEAD).
#[tauri::command]
pub async fn refresh_workspace_branch(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    claudette::workspace_sync::reconcile_single_workspace_branch(&state.db_path, &workspace_id)
        .await
}

#[derive(Serialize)]
pub struct DiscoveredWorktree {
    pub path: String,
    pub branch_name: String,
    pub head_sha: String,
    pub suggested_name: String,
    pub name_valid: bool,
}

/// Validate a workspace name: ASCII alphanumeric + hyphens, no leading/trailing hyphens.
fn is_valid_workspace_name(name: &str) -> bool {
    claudette::workspace_alloc::is_valid_workspace_name(name)
}

/// Discover existing git worktrees for a repository that are not yet tracked in Claudette.
#[tauri::command]
pub async fn discover_worktrees(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DiscoveredWorktree>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    let worktrees = git::list_worktrees(&repo.path)
        .await
        .map_err(|e| e.to_string())?;

    // Build sets of already-tracked paths and branches for filtering.
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let tracked_paths: std::collections::HashSet<String> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo_id)
        .filter_map(|w| w.worktree_path.clone())
        .collect();
    let tracked_branches: std::collections::HashSet<&str> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo_id)
        .map(|w| w.branch_name.as_str())
        .collect();

    let repo_canon = std::fs::canonicalize(&repo.path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| repo.path.clone());

    let mut discovered = Vec::new();

    for wt in worktrees {
        // Skip the main repo entry.
        let wt_canon = std::fs::canonicalize(&wt.path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| wt.path.clone());
        if wt_canon == repo_canon || wt.is_bare {
            continue;
        }

        // Skip detached HEAD worktrees.
        let branch = match &wt.branch {
            Some(b) => b.clone(),
            None => continue,
        };

        // Skip worktrees that don't exist on disk.
        if !Path::new(&wt.path).is_dir() {
            continue;
        }

        // Skip already-tracked worktrees.
        if tracked_paths.contains(&wt_canon) || tracked_branches.contains(branch.as_str()) {
            continue;
        }

        let suggested_name = Path::new(&wt.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let name_valid = is_valid_workspace_name(&suggested_name);

        discovered.push(DiscoveredWorktree {
            path: wt_path_display(&wt.path),
            branch_name: branch,
            head_sha: wt.head,
            suggested_name,
            name_valid,
        });
    }

    Ok(discovered)
}

/// Return a display-friendly path (use the raw path, not canonicalized).
fn wt_path_display(path: &str) -> String {
    path.to_string()
}

#[derive(Deserialize)]
pub struct WorktreeImport {
    pub path: String,
    pub branch_name: String,
    pub name: String,
}

/// Import existing git worktrees as Claudette workspaces.
///
/// Re-validates each import against `git worktree list` to ensure the paths
/// are genuine linked worktrees. All inserts are atomic — either all succeed
/// or none are committed.
#[tauri::command]
pub async fn import_worktrees(
    repo_id: String,
    imports: Vec<WorktreeImport>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Workspace>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    // Re-validate imports against the actual git worktree list.
    let worktrees = git::list_worktrees(&repo.path)
        .await
        .map_err(|e| e.to_string())?;
    let valid_worktree_paths: std::collections::HashSet<String> = worktrees
        .iter()
        .filter(|wt| wt.branch.is_some() && !wt.is_bare)
        .filter_map(|wt| {
            std::fs::canonicalize(&wt.path)
                .map(|p| p.to_string_lossy().to_string())
                .ok()
        })
        .collect();

    let mut created = Vec::new();

    for imp in &imports {
        if !is_valid_workspace_name(&imp.name) {
            return Err(format!("Invalid workspace name: '{}'", imp.name));
        }

        let canon = std::fs::canonicalize(&imp.path)
            .map_err(|e| format!("Invalid path '{}': {e}", imp.path))?;
        let canon_str = canon.to_string_lossy().to_string();

        if !valid_worktree_paths.contains(&canon_str) {
            return Err(format!(
                "'{}' is not a linked worktree of this repository",
                imp.path
            ));
        }

        let ws = Workspace {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id: repo_id.clone(),
            name: imp.name.clone(),
            branch_name: imp.branch_name.clone(),
            worktree_path: Some(canon_str),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: now_iso(),
            sort_order: 0,
        };

        created.push(ws);
    }

    // Atomic batch insert — all or nothing.
    db.insert_workspaces_batch(&created)
        .map_err(|e| e.to_string())?;
    // Patch each row's sort_order to the value the DB assigned so the
    // workspaces this command returns to the UI render at the bottom of
    // their repo groups immediately (Codex P2). One readback query per
    // import; imports are rare and bounded so no batching needed.
    for ws in created.iter_mut() {
        if let Ok(Some(o)) = db.lookup_workspace_sort_order(&ws.id) {
            ws.sort_order = o;
        }
    }

    // Imported workspaces already have user-defined branch names — pre-claim
    // the auto-rename slot so the first-message rename never fires. Match the
    // logging in chat/send.rs so a SQLite failure here is visible rather than
    // silently leaving the workspace eligible for rename.
    for ws in &created {
        if let Err(e) = db.claim_branch_auto_rename(&ws.id) {
            tracing::warn!(
                target: "claudette::workspace",
                workspace_id = %ws.id,
                workspace_name = %ws.name,
                error = %e,
                "claim_branch_auto_rename failed during import"
            );
        }
    }

    crate::tray::rebuild_tray(&app);

    Ok(created)
}

#[tauri::command]
pub async fn open_workspace_in_terminal(
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tracing::info!(target: "claudette::workspace", worktree_path = %worktree_path, "opening terminal for workspace");

    let default_terminal_app_id = Database::open(&state.db_path).ok().and_then(|db| {
        db.get_app_setting(DEFAULT_TERMINAL_APP_SETTING_KEY)
            .ok()
            .flatten()
    });
    let app_id = {
        let detected_apps = state.detected_apps.read().await;
        apps::select_workspace_terminal_app_id(&detected_apps, default_terminal_app_id.as_deref())
    };

    if let Some(app_id) = app_id {
        tracing::info!(
            target: "claudette::workspace",
            terminal_app_id = %app_id,
            configured_terminal_app_id = ?default_terminal_app_id,
            "opening workspace in detected terminal app"
        );
        return apps::open_workspace_in_app_inner(&app_id, &worktree_path, state.inner()).await;
    }

    tracing::warn!(
        target: "claudette::workspace",
        configured_terminal_app_id = ?default_terminal_app_id,
        "no detected terminal app found; using platform fallback"
    );

    #[cfg(target_os = "linux")]
    {
        // Try common Linux terminal emulators
        // For xterm: escape single quotes by replacing ' with '\''
        let xterm_escaped = worktree_path.replace('\'', r"'\''");
        let xterm_cmd = format!("cd '{}' && exec bash", xterm_escaped);
        let terminals: Vec<(&str, Vec<&str>)> = vec![
            (
                "gnome-terminal",
                vec!["--working-directory", &worktree_path],
            ),
            ("konsole", vec!["--workdir", &worktree_path]),
            (
                "xfce4-terminal",
                vec!["--working-directory", &worktree_path],
            ),
            ("xterm", vec!["-e", "bash", "-c", &xterm_cmd]),
            ("alacritty", vec!["--working-directory", &worktree_path]),
            ("kitty", vec!["--directory", &worktree_path]),
        ];

        let mut errors = Vec::new();
        for (terminal, args) in &terminals {
            let mut cmd = tokio::process::Command::new(terminal);
            cmd.no_console_window();
            for arg in args {
                cmd.arg(arg);
            }

            match cmd.spawn() {
                Ok(_) => {
                    tracing::info!(
                        target: "claudette::workspace",
                        terminal = %terminal,
                        args = ?args,
                        "successfully launched terminal"
                    );
                    return Ok(());
                }
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::workspace",
                        terminal = %terminal,
                        error = %e,
                        "failed to launch terminal"
                    );
                    errors.push(format!("{terminal}: {e}"));
                }
            }
        }

        Err(format!(
            "No terminal emulator found. Tried: {}",
            errors.join(", ")
        ))
    }

    #[cfg(target_os = "macos")]
    {
        // Use AppleScript to open Terminal.app
        // Escape both single quotes and backslashes for AppleScript string within shell command
        let escaped = worktree_path.replace('\\', r"\\").replace('\'', r"'\''");

        let script = format!(
            r#"tell application "Terminal"
                activate
                do script "cd '{escaped}'; exec bash"
            end tell"#
        );

        tokio::process::Command::new("osascript")
            .no_console_window()
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {e}"))?;

        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // Reach this branch only when no terminal app was detected at
        // startup — `apps.json` is missing or the user has no terminal
        // emulator on PATH. Try the four shipping-on-every-Windows
        // terminals in order of "likely-installed-and-pleasant":
        // Windows Terminal first (Win11 default + nicer UX), pwsh
        // second (modern PowerShell), then Windows PowerShell, then
        // cmd.exe (always present, last-resort). `new_console_window`
        // ensures cmd/pwsh actually surface a window — see
        // `process.rs::new_console_window` for the rationale.
        let attempts: &[(&str, Vec<&str>)] = &[
            ("wt.exe", vec!["-d", &worktree_path]),
            (
                "pwsh.exe",
                vec!["-NoExit", "-WorkingDirectory", &worktree_path],
            ),
            (
                "powershell.exe",
                vec!["-NoExit", "-WorkingDirectory", &worktree_path],
            ),
            ("cmd.exe", vec!["/K", "cd", "/d", &worktree_path]),
        ];

        let mut errors = Vec::new();
        for (binary, args) in attempts {
            let mut cmd = tokio::process::Command::new(binary);
            cmd.new_console_window();
            for arg in args {
                cmd.arg(arg);
            }
            match cmd.spawn() {
                Ok(_) => {
                    tracing::info!(
                        target: "claudette::workspace",
                        terminal = %binary,
                        args = ?args,
                        "successfully launched windows terminal fallback"
                    );
                    return Ok(());
                }
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::workspace",
                        terminal = %binary,
                        error = %e,
                        "failed to launch windows terminal fallback"
                    );
                    errors.push(format!("{binary}: {e}"));
                }
            }
        }

        Err(format!(
            "No Windows terminal could be launched. Tried: {}",
            errors.join(", ")
        ))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Err("Unsupported platform".to_string())
    }
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
