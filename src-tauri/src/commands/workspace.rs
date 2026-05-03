use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use claudette::db::Database;
use claudette::fork::{self, ForkInputs};
use claudette::git;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::model::{AgentStatus, Workspace, WorkspaceStatus};
use claudette::names::NameGenerator;
use claudette::ops::workspace::{self as ops_workspace, CreateParams, SetupResult};
use claudette::process::CommandWindowExt as _;

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
pub async fn create_workspace(
    repo_id: String,
    name: String,
    skip_setup: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CreateWorkspaceResult, String> {
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let (prefix_mode, prefix_custom) = ops_workspace::read_branch_prefix_settings(&db);
    let prefix = ops_workspace::resolve_branch_prefix(&prefix_mode, &prefix_custom).await;
    let worktree_base = state.worktree_base_dir.read().await.clone();

    let out = ops_workspace::create(
        &mut db,
        TauriHooks::new(app.clone()).as_ref(),
        worktree_base.as_path(),
        CreateParams {
            repo_id: &repo_id,
            name: &name,
            branch_prefix: &prefix,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Setup script runs after the workspace exists so we can resolve the
    // env-provider stack against the worktree path, then thread the
    // resulting env into the script's process. The op intentionally
    // stays out of env resolution because the plugin registry lives in
    // AppState — only the GUI has it today.
    let setup_result = if skip_setup.unwrap_or(false) {
        None
    } else {
        let repos = db.list_repositories().map_err(|e| e.to_string())?;
        let repo = repos
            .iter()
            .find(|r| r.id == repo_id)
            .ok_or("Repository not found")?;
        let resolved_env = resolve_env_for_workspace(&state, &out.workspace, &repo.path).await;
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

    crate::tray::rebuild_tray(&app);

    Ok(ForkWorkspaceResult {
        workspace: outcome.workspace,
        session_resumed: outcome.session_resumed,
    })
}

#[tauri::command]
pub async fn run_workspace_setup(
    workspace_id: String,
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

    let resolved_env = resolve_env_for_workspace(&state, ws, &repo.path).await;
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
/// Returns `None` when the workspace has no worktree path yet (which
/// shouldn't happen by the time we're about to spawn, but keeps the
/// call sites defensive).
async fn resolve_env_for_workspace(
    state: &AppState,
    ws: &Workspace,
    repo_path: &str,
) -> Option<claudette::env_provider::ResolvedEnv> {
    let worktree = ws.worktree_path.as_deref()?;
    let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: ws.id.clone(),
        name: ws.name.clone(),
        branch: ws.branch_name.clone(),
        worktree_path: worktree.to_string(),
        repo_path: repo_path.to_string(),
    };
    let disabled = Database::open(&state.db_path)
        .map(|db| crate::commands::env::load_disabled_providers(&db, &ws.repository_id))
        .unwrap_or_default();
    let registry = state.plugins.read().await;
    let resolved = claudette::env_provider::resolve_with_registry(
        &registry,
        &state.env_cache,
        Path::new(worktree),
        &ws_info,
        &disabled,
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
pub async fn archive_workspace(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<bool, String> {
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // The user-visible "delete branch on archive" setting lives in app
    // settings; we read it sync before the op so we can pass the boolean
    // through cleanly without the op needing DB access for settings.
    let delete_branch = db
        .get_app_setting("git_delete_branch_on_archive")
        .ok()
        .flatten()
        .as_deref()
        == Some("true");

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

    let out = ops_workspace::archive(
        &mut db,
        TauriHooks::new(app.clone()).as_ref(),
        ops_workspace::ArchiveParams {
            workspace_id: &id,
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

    Ok(delete_branch)
}

#[tauri::command]
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
            eprintln!(
                "[import] claim_branch_auto_rename failed for {} ({}): {e}",
                ws.name, ws.id
            );
        }
    }

    crate::tray::rebuild_tray(&app);

    Ok(created)
}

#[tauri::command]
pub async fn open_workspace_in_terminal(worktree_path: String) -> Result<(), String> {
    eprintln!("Opening terminal for path: {worktree_path}");

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
                    eprintln!("Successfully launched {terminal} with args: {args:?}");
                    return Ok(());
                }
                Err(e) => {
                    eprintln!("Failed to launch {terminal}: {e}");
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

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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
