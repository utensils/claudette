//! Workspace lifecycle operations shared by every Claudette surface.
//!
//! Before this module existed, `create_workspace` (and its peers) lived in
//! parallel implementations in `src-tauri/src/commands/workspace.rs` and
//! `src-server/src/handler.rs`. The two drifted: the server skipped the
//! setup script, did not resolve the env-provider stack, did not run
//! tray/notification side effects, and did not return the auto-created
//! `default_session_id` that the GUI relied on. Both implementations now
//! call into the functions here, restoring parity.
//!
//! Side effects (tray rebuild, notification sound, frontend events) are
//! delegated to the caller's [`OpsHooks`](super::OpsHooks) impl. Plugin-
//! mediated env resolution stays at the caller because the plugin registry
//! lives in the GUI's `AppState` — callers that have one pass a
//! [`ResolvedEnv`] in; callers that don't (the WS server today) pass `None`.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command as TokioCommand;

use crate::agent;
use crate::config;
use crate::db::Database;
use crate::env::{WorkspaceEnv, enriched_path};
use crate::env_provider::ResolvedEnv;
use crate::git;
use crate::model::{AgentStatus, Workspace, WorkspaceStatus};
use crate::process::CommandWindowExt as _;
use crate::workspace_alloc::{allocate_workspace_name, is_valid_workspace_name};

use super::{NotificationEvent, OpsError, OpsHooks, WorkspaceChangeKind};

const CREATE_WORKTREE_ALLOCATION_ATTEMPTS: usize = 5;
/// Hard cap on setup and archive script wall-clock time. Five minutes is
/// enough for `bun install` / `cargo build` first-runs but short enough
/// that a stuck script doesn't wedge workspace creation or archival
/// indefinitely. Shared between setup and archive so the two budgets can't
/// silently diverge.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(300);

/// Outcome of running a workspace's setup script. Both fields the GUI
/// surfaces in its post-create system message and the WS-server clients
/// can consume the same shape.
#[derive(Debug, Clone, Serialize)]
pub struct SetupResult {
    /// Where the script came from: `"repo"` (`.claudette.json`) or
    /// `"settings"` (per-repo settings fallback).
    pub source: String,
    pub script: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
}

/// Inputs to [`create`] — kept as a struct so the function signature stays
/// readable as flags accumulate.
pub struct CreateParams<'a> {
    pub repo_id: &'a str,
    pub name: &'a str,
    /// Branch prefix already resolved by the caller (e.g.
    /// `"jamesbrink/"`). Empty string is allowed.
    pub branch_prefix: &'a str,
}

/// Result of a successful [`create`]. `default_session_id` is the chat
/// session that `Database::insert_workspace` auto-creates — every caller
/// needs it to post initial system messages (setup output, agent prompt)
/// to the new workspace's chat. `worktree_path` is the canonicalized
/// path returned by `git worktree add` — callers re-use it instead of
/// re-canonicalizing.
#[derive(Debug, Serialize)]
pub struct CreateOutput {
    pub workspace: Workspace,
    pub default_session_id: String,
    pub worktree_path: String,
}

/// Create a new workspace: allocate a name, create a git worktree + branch,
/// insert the DB row (which auto-creates a default chat session), and fire
/// hooks.
///
/// **Setup script execution is intentionally a separate concern** — see
/// [`resolve_and_run_setup`]. Callers that have a plugin registry handy
/// (the GUI) resolve env first, then run setup; callers that don't (the
/// WS server today) can run setup with `resolved_env = None`.
///
/// On any failure after the worktree is created, the worktree and branch are
/// removed so we never leave orphan git state pointing at a workspace that
/// isn't in the DB.
///
/// `&mut Database` (rather than `&Database`) so the returned future is
/// `Send` — see [`claudette::fork::fork_workspace_at_checkpoint`] for the
/// same workaround. `Database` wraps a `rusqlite::Connection`, which is
/// `Send` but `!Sync`; an exclusive borrow lets the borrow span awaits
/// without forcing the future to require `Sync` on the connection.
pub async fn create(
    db: &mut Database,
    hooks: &dyn OpsHooks,
    worktree_base: &Path,
    params: CreateParams<'_>,
) -> Result<CreateOutput, OpsError> {
    create_inner(db, hooks, worktree_base, params, false).await
}

/// Create a workspace while preserving the supplied display name and branch
/// name after the first prompt. This is intended for script-driven callers
/// such as the CLI and batch runner, where the provided name is a stable
/// handle rather than a throwaway default.
pub async fn create_preserving_supplied_name(
    db: &mut Database,
    hooks: &dyn OpsHooks,
    worktree_base: &Path,
    params: CreateParams<'_>,
) -> Result<CreateOutput, OpsError> {
    create_inner(db, hooks, worktree_base, params, true).await
}

async fn create_inner(
    db: &mut Database,
    hooks: &dyn OpsHooks,
    worktree_base: &Path,
    params: CreateParams<'_>,
    preserve_supplied_name: bool,
) -> Result<CreateOutput, OpsError> {
    if !is_valid_workspace_name(params.name) {
        return Err(OpsError::Validation(format!(
            "Invalid workspace name: '{}'",
            params.name
        )));
    }

    let repos = db.list_repositories()?;
    let repo = repos
        .iter()
        .find(|r| r.id == params.repo_id)
        .ok_or_else(|| OpsError::NotFound("Repository not found".to_string()))?;

    let repo_path = repo.path.clone();

    let (allocation, actual_path) = {
        let mut last_collision: Option<git::GitError> = None;
        let mut created = None;

        for _ in 0..CREATE_WORKTREE_ALLOCATION_ATTEMPTS {
            let workspaces = db.list_workspaces()?;
            let allocation = allocate_workspace_name(
                repo,
                &workspaces,
                params.name,
                params.branch_prefix,
                worktree_base,
            )
            .await
            .map_err(|e| OpsError::Repo(e.to_string()))?;
            let worktree_path_str = allocation.worktree_path.to_string_lossy().to_string();

            match git::create_worktree(
                &repo_path,
                &allocation.branch_name,
                &worktree_path_str,
                repo.base_branch.as_deref(),
                repo.default_remote.as_deref(),
            )
            .await
            {
                Ok(actual_path) => {
                    created = Some((allocation, actual_path));
                    break;
                }
                Err(err) if git::is_worktree_create_collision_error(&err) => {
                    last_collision = Some(err);
                }
                Err(err) => return Err(OpsError::Git(err)),
            }
        }

        created.ok_or_else(|| {
            OpsError::Repo(
                last_collision
                    .map(|err| err.to_string())
                    .unwrap_or_else(|| "Could not allocate a unique workspace name".to_string()),
            )
        })?
    };

    let mut ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: params.repo_id.to_string(),
        name: allocation.name,
        branch_name: allocation.branch_name.clone(),
        worktree_path: Some(actual_path.clone()),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: now_iso(),
        sort_order: 0,
    };

    if let Err(e) = db.insert_workspace(&ws) {
        let _ = git::remove_worktree(&repo_path, &actual_path, true).await;
        let _ = git::branch_delete(&repo_path, &ws.branch_name).await;
        return Err(OpsError::Db(e));
    }
    // Patch sort_order to the value the DB assigned so the workspace this
    // op returns lands at the bottom of its repo group immediately, instead
    // of rendering at sort_order=0 until the next workspace-list reload.
    if let Ok(Some(o)) = db.lookup_workspace_sort_order(&ws.id) {
        ws.sort_order = o;
    }

    if preserve_supplied_name {
        db.claim_branch_auto_rename(&ws.id)?;
    }

    let default_session_id = db
        .default_session_id_for_workspace(&ws.id)?
        .ok_or_else(|| {
            OpsError::Other("Workspace insert did not create a default chat session".to_string())
        })?;

    hooks.workspace_changed(&ws.id, WorkspaceChangeKind::Created);
    hooks.notification(NotificationEvent::SessionStart);

    Ok(CreateOutput {
        workspace: ws,
        default_session_id,
        worktree_path: actual_path,
    })
}

/// Build the platform-default shell invocation Claudette uses to run
/// user setup / archive scripts.
///
/// POSIX hosts get `sh -c <script>`; Windows gets `cmd.exe /S /C <script>`
/// so a stock install (no Git Bash on PATH) can still execute scripts —
/// this matches the shape `commands/settings.rs::build_notification_command`
/// already uses for user-supplied notification commands. Common spawn
/// configuration (cwd, enriched PATH, piped stdio, Unix process group for
/// timeout-driven SIGKILL of the entire subtree) is applied here so the
/// two callers — setup and archive — stay byte-identical.
fn build_script_command(script: &str, worktree_path: &Path) -> TokioCommand {
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = TokioCommand::new("sh");
        c.arg("-c").arg(script);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = TokioCommand::new("cmd.exe");
        // /S = leave the rest of the command line alone (no double-quote
        // stripping); /C = run the command and exit. Same flags used by
        // the notification-command builder.
        c.arg("/S").arg("/C").arg(script);
        c
    };
    cmd.no_console_window();
    cmd.current_dir(worktree_path)
        .env("PATH", enriched_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Process group on Unix so a timeout SIGKILL hits every grandchild
    // (e.g. `npm install` spawns workers that wouldn't exit otherwise).
    // Windows has no process-group signal — the timeout path runs
    // `taskkill /T /F` on the child PID (see [`kill_script_subtree`])
    // before falling through to `child.kill().await` as belt-and-
    // suspenders.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

/// Best-effort termination of a hung setup / archive script and every
/// descendant it spawned. Runs in the timeout arm of both
/// [`resolve_and_run_setup`] and [`resolve_and_run_archive`] before the
/// caller's `child.kill().await`.
///
/// On Unix the caller does the work itself with `kill(-pgid, SIGKILL)`
/// — the spawn set `process_group(0)`, so a single syscall fells the
/// whole tree. On Windows there is no equivalent: `child.kill()` is
/// `TerminateProcess` on the immediate child only, so a hung
/// `npm install` would leave its compiler/installer workers orphaned to
/// the desktop session. `taskkill /T /F` walks the per-PID descendant
/// tree the kernel already tracks and force-terminates everything in
/// one call. Errors are ignored because `child.kill().await` is the
/// fallback and we're already in a "we don't care, just kill it" path.
#[cfg(windows)]
async fn kill_script_subtree(pid: u32) {
    let _ = TokioCommand::new("taskkill")
        .no_console_window()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .await;
}

/// Resolve the setup script (preferring `.claudette.json`, falling back to
/// the per-repo settings script) and execute it. Returns `None` when no
/// script is configured — the common case for newly-added repositories.
///
/// `WorkspaceEnv` is built lazily — `git::default_branch()` is only called
/// once we know a script will actually run.
pub async fn resolve_and_run_setup(
    ws: &Workspace,
    repo_path: &Path,
    worktree_path: &Path,
    settings_script: Option<&str>,
    base_branch: Option<&str>,
    default_remote: Option<&str>,
    resolved_env: Option<&ResolvedEnv>,
) -> Option<SetupResult> {
    let (script, source) = match config::load_config(repo_path) {
        Ok(Some(cfg)) => {
            if let Some(setup) = cfg.scripts.and_then(|s| s.setup) {
                (setup, "repo")
            } else if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return None;
            }
        }
        Ok(None) => {
            if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return None;
            }
        }
        Err(parse_err) => {
            tracing::warn!(
                target: "claudette::workspace",
                phase = "setup",
                error = %parse_err,
                "failed to parse repo setup script"
            );
            if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return Some(SetupResult {
                    source: "repo".to_string(),
                    script: String::new(),
                    output: parse_err,
                    exit_code: None,
                    success: false,
                    timed_out: false,
                });
            }
        }
    };

    let repo_path_str = repo_path.to_string_lossy();
    let default_branch = match base_branch {
        Some(b) => b.to_string(),
        None => git::default_branch(&repo_path_str, default_remote)
            .await
            .unwrap_or_else(|_| "main".to_string()),
    };
    let ws_env = WorkspaceEnv::from_workspace(ws, &repo_path_str, default_branch);

    let mut cmd = build_script_command(&script, worktree_path);
    if let Some(env) = resolved_env {
        env.apply(&mut cmd);
    }
    ws_env.apply(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Some(SetupResult {
                source: source.to_string(),
                script,
                output: format!("Failed to spawn script: {e}"),
                exit_code: None,
                success: false,
                timed_out: false,
            });
        }
    };

    let pid = child.id();

    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout_handle {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut out, &mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr_handle {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut err, &mut buf).await;
        }
        buf
    });

    match tokio::time::timeout(SCRIPT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => {
            let stdout_buf = stdout_task.await.unwrap_or_default();
            let stderr_buf = stderr_task.await.unwrap_or_default();
            let stdout = String::from_utf8_lossy(&stdout_buf);
            let stderr = String::from_utf8_lossy(&stderr_buf);
            let combined = if stderr.is_empty() {
                stdout.to_string()
            } else if stdout.is_empty() {
                stderr.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            };
            let code = status.code();
            Some(SetupResult {
                source: source.to_string(),
                script,
                output: combined,
                exit_code: code,
                success: code == Some(0),
                timed_out: false,
            })
        }
        Ok(Err(e)) => Some(SetupResult {
            source: source.to_string(),
            script,
            output: format!("Script execution error: {e}"),
            exit_code: None,
            success: false,
            timed_out: false,
        }),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pgid) = pid {
                unsafe {
                    libc::kill(-(pgid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            if let Some(child_pid) = pid {
                kill_script_subtree(child_pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Drain the reader tasks deterministically. Killing the child
            // closes its stdio pipes so the read_to_end calls return on
            // their own; awaiting here just ensures both tasks have exited
            // before we return rather than leaving them detached.
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            // Format the deadline from the actual constant so changing
            // SCRIPT_TIMEOUT updates the user-visible diagnostic
            // automatically. Whole-second precision is plenty here.
            Some(SetupResult {
                source: source.to_string(),
                script,
                output: format!(
                    "Setup script timed out after {} seconds",
                    SCRIPT_TIMEOUT.as_secs()
                ),
                exit_code: None,
                success: false,
                timed_out: true,
            })
        }
    }
}

/// Resolve the archive script (preferring `.claudette.json`, falling back to
/// the per-repo settings script) and execute it before the worktree is
/// removed. Returns `None` when no script is configured.
pub async fn resolve_and_run_archive(
    ws: &Workspace,
    repo_path: &Path,
    worktree_path: &Path,
    settings_script: Option<&str>,
    base_branch: Option<&str>,
    default_remote: Option<&str>,
    resolved_env: Option<&ResolvedEnv>,
) -> Option<SetupResult> {
    let (script, source) = match config::load_config(repo_path) {
        Ok(Some(cfg)) => {
            if let Some(archive) = cfg.scripts.and_then(|s| s.archive) {
                (archive, "repo")
            } else if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return None;
            }
        }
        Ok(None) => {
            if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return None;
            }
        }
        Err(parse_err) => {
            tracing::warn!(
                target: "claudette::workspace",
                phase = "archive",
                error = %parse_err,
                "failed to parse repo archive script"
            );
            if let Some(fallback) = settings_script {
                (fallback.to_string(), "settings")
            } else {
                return Some(SetupResult {
                    source: "repo".to_string(),
                    script: String::new(),
                    output: parse_err,
                    exit_code: None,
                    success: false,
                    timed_out: false,
                });
            }
        }
    };

    let repo_path_str = repo_path.to_string_lossy();
    let default_branch = match base_branch {
        Some(b) => b.to_string(),
        None => git::default_branch(&repo_path_str, default_remote)
            .await
            .unwrap_or_else(|_| "main".to_string()),
    };
    let ws_env = WorkspaceEnv::from_workspace(ws, &repo_path_str, default_branch);

    let mut cmd = build_script_command(&script, worktree_path);
    if let Some(env) = resolved_env {
        env.apply(&mut cmd);
    }
    ws_env.apply(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Some(SetupResult {
                source: source.to_string(),
                script,
                output: format!("Failed to spawn script: {e}"),
                exit_code: None,
                success: false,
                timed_out: false,
            });
        }
    };

    let pid = child.id();

    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut out) = stdout_handle {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut out, &mut buf).await;
        }
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr_handle {
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut err, &mut buf).await;
        }
        buf
    });

    match tokio::time::timeout(SCRIPT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => {
            let stdout_buf = stdout_task.await.unwrap_or_default();
            let stderr_buf = stderr_task.await.unwrap_or_default();
            let stdout = String::from_utf8_lossy(&stdout_buf);
            let stderr = String::from_utf8_lossy(&stderr_buf);
            let combined = if stderr.is_empty() {
                stdout.to_string()
            } else if stdout.is_empty() {
                stderr.to_string()
            } else {
                format!("{stdout}\n{stderr}")
            };
            let code = status.code();
            Some(SetupResult {
                source: source.to_string(),
                script,
                output: combined,
                exit_code: code,
                success: code == Some(0),
                timed_out: false,
            })
        }
        Ok(Err(e)) => Some(SetupResult {
            source: source.to_string(),
            script,
            output: format!("Script execution error: {e}"),
            exit_code: None,
            success: false,
            timed_out: false,
        }),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pgid) = pid {
                unsafe {
                    libc::kill(-(pgid as i32), libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            if let Some(child_pid) = pid {
                kill_script_subtree(child_pid).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            Some(SetupResult {
                source: source.to_string(),
                script,
                output: format!(
                    "Archive script timed out after {} seconds",
                    SCRIPT_TIMEOUT.as_secs()
                ),
                exit_code: None,
                success: false,
                timed_out: true,
            })
        }
    }
}

/// Resolve the configured branch prefix for a workspace.
///
/// `mode` is one of `"username"` (default — read `git config user.name`),
/// `"custom"` (use `custom_value` verbatim, normalized), or `"none"` (empty
/// prefix). Always returns either an empty string or a string ending with
/// `"/"` so callers can concatenate without checking.
pub async fn resolve_branch_prefix(mode: &str, custom_value: &str) -> String {
    match mode {
        "custom" => {
            let sanitized = custom_value
                .trim()
                .trim_matches('/')
                .split('/')
                .filter_map(|segment| {
                    let s = agent::sanitize_branch_name(segment.trim(), 30);
                    if s.is_empty() { None } else { Some(s) }
                })
                .collect::<Vec<_>>()
                .join("/");
            if sanitized.is_empty() {
                String::new()
            } else {
                format!("{sanitized}/")
            }
        }
        "none" => String::new(),
        _ => match git::get_git_username().await {
            Ok(Some(name)) => {
                let slug = agent::sanitize_branch_name(&name, 30);
                if slug.is_empty() {
                    "claudette/".to_string()
                } else {
                    format!("{slug}/")
                }
            }
            _ => "claudette/".to_string(),
        },
    }
}

/// Inputs to [`archive`].
pub struct ArchiveParams<'a> {
    pub workspace_id: &'a str,
    /// Whether to delete the workspace's branch as well as the worktree.
    /// Reflects the `git_delete_branch_on_archive` app setting — the GUI
    /// reads it from the DB; other callers (CLI, scripts) typically pass
    /// `false` unless the user explicitly opts in.
    pub delete_branch: bool,
}

/// Result of a successful [`archive`]. `branch_deleted` reflects whether
/// the branch was actually removed (depends on `delete_branch` and whether
/// the branch existed); `was_last_workspace` lets callers know they should
/// also tear down repository-scoped state (MCP supervisor, status caches).
#[derive(Debug, Serialize)]
pub struct ArchiveOutput {
    pub branch_deleted: bool,
    pub was_last_workspace: bool,
    /// The workspace's prior worktree path, if any. Callers use this to
    /// invalidate env-provider watchers and terminal sessions that pointed
    /// at the now-defunct worktree.
    pub worktree_path: Option<String>,
    /// `repository_id` of the archived workspace, surfaced so callers can
    /// run repo-scoped cleanup without re-querying the DB.
    pub repository_id: String,
}

/// Archive a workspace: remove its worktree, optionally delete its branch,
/// clear its terminal-tab and SCM-status cache rows, mark it
/// [`WorkspaceStatus::Archived`], and fire hooks.
///
/// Caller responsibilities (not handled here because they're per-process
/// state, not shared DB/git state):
/// - Stop any running agents whose `workspace_id` matches before invoking
///   this op (the GUI keeps agent process state in `AppState.agents`).
/// - Invalidate env-provider watcher entries rooted at the worktree path
///   returned in [`ArchiveOutput::worktree_path`] (the watcher lives in
///   `AppState.env_watcher`).
///
/// When `delete_branch` is true and the workspace was the last one in its
/// repository, the row is hard-deleted via
/// `delete_workspace_with_summary` (lifetime stats survive in
/// `deleted_workspace_summaries`); otherwise the row is left as Archived
/// so the user can restore it later.
pub async fn archive(
    db: &mut Database,
    hooks: &dyn OpsHooks,
    params: ArchiveParams<'_>,
) -> Result<ArchiveOutput, OpsError> {
    let workspaces = db.list_workspaces()?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == params.workspace_id)
        .ok_or_else(|| OpsError::NotFound("Workspace not found".to_string()))?;

    let repos = db.list_repositories()?;
    let repo = repos
        .iter()
        .find(|r| r.id == ws.repository_id)
        .ok_or_else(|| OpsError::NotFound("Repository not found".to_string()))?;

    let repository_id = ws.repository_id.clone();
    let worktree_path = ws.worktree_path.clone();
    let branch_name = ws.branch_name.clone();
    let workspace_id = ws.id.clone();
    let repo_path = repo.path.clone();

    if let Some(ref wt_path) = worktree_path {
        let _ = git::remove_worktree(&repo_path, wt_path, false).await;
    }

    let branch_deleted = if params.delete_branch {
        git::branch_delete(&repo_path, &branch_name).await.is_ok()
    } else {
        false
    };

    if params.delete_branch {
        // Branch is gone — nothing left to restore. Hard-delete via
        // `delete_workspace_with_summary` so lifetime stats survive
        // in `deleted_workspace_summaries`.
        db.delete_workspace_with_summary(&workspace_id)?;
    } else {
        db.delete_terminal_tabs_for_workspace(&workspace_id)?;
        db.delete_scm_status_cache(&workspace_id)?;
        db.update_workspace_status(&workspace_id, &WorkspaceStatus::Archived, None)?;
    }

    let remaining = db.list_workspaces()?;
    let was_last_workspace = !remaining.iter().any(|w| w.repository_id == repository_id);

    // `delete_branch` hard-deletes the workspace row above; surface that
    // distinction to UI subscribers so the frontend can `removeWorkspace`
    // (Deleted) instead of `updateWorkspace { status: Archived }` against
    // a row that no longer exists.
    let kind = if params.delete_branch {
        WorkspaceChangeKind::Deleted
    } else {
        WorkspaceChangeKind::Archived
    };
    hooks.workspace_changed(&workspace_id, kind);

    Ok(ArchiveOutput {
        branch_deleted,
        was_last_workspace,
        worktree_path,
        repository_id,
    })
}

/// Read the two app-settings keys that drive the branch prefix. Synchronous
/// so callers can read while the `Database` (`rusqlite::Connection` —
/// `!Send`) is in scope, then drop the handle before awaiting
/// [`resolve_branch_prefix`].
pub fn read_branch_prefix_settings(db: &Database) -> (String, String) {
    let mode = db
        .get_app_setting("git_branch_prefix_mode")
        .ok()
        .flatten()
        .unwrap_or_else(|| "username".to_string());
    let custom = db
        .get_app_setting("git_branch_prefix_custom")
        .ok()
        .flatten()
        .unwrap_or_default();
    (mode, custom)
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Repository;
    use std::sync::Mutex;

    /// Hook impl that records every change so tests can assert the
    /// surface contract (e.g. archive emits Deleted vs Archived).
    #[derive(Default)]
    struct RecordingHooks {
        changes: Mutex<Vec<(String, WorkspaceChangeKind)>>,
    }

    impl OpsHooks for RecordingHooks {
        fn workspace_changed(&self, workspace_id: &str, kind: WorkspaceChangeKind) {
            self.changes
                .lock()
                .unwrap()
                .push((workspace_id.to_string(), kind));
        }
    }

    impl RecordingHooks {
        fn changes(&self) -> Vec<(String, WorkspaceChangeKind)> {
            self.changes.lock().unwrap().clone()
        }
    }

    async fn run_git_in(repo_path: &std::path::Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?} failed in {repo_path:?}");
    }

    /// Build a real git repo + Database with one Repository row pointing
    /// at it so `create` / `archive` can exercise the full pipeline.
    /// Returns the temp dirs (kept alive for the test) plus the DB.
    async fn setup_repo_and_db() -> (tempfile::TempDir, tempfile::TempDir, Database, Repository) {
        let repo_dir = tempfile::tempdir().unwrap();
        let repo_path = repo_dir.path();
        run_git_in(repo_path, &["init", "-b", "main"]).await;
        run_git_in(repo_path, &["config", "user.email", "test@test.com"]).await;
        run_git_in(repo_path, &["config", "user.name", "Test"]).await;
        std::fs::write(repo_path.join("README.md"), "# test").unwrap();
        run_git_in(repo_path, &["add", "-A"]).await;
        run_git_in(repo_path, &["commit", "-m", "initial"]).await;

        let db_dir = tempfile::tempdir().unwrap();
        let db = Database::open(&db_dir.path().join("test.db")).unwrap();

        let repo = Repository {
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".to_string(),
            path: repo_path.to_string_lossy().to_string(),
            path_slug: "test".to_string(),
            icon: None,
            created_at: now_iso(),
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
        };
        db.insert_repository(&repo).unwrap();

        (repo_dir, db_dir, db, repo)
    }

    #[tokio::test]
    async fn create_leaves_auto_rename_available_by_default() {
        let (_repo_dir, _db_dir, mut db, repo) = setup_repo_and_db().await;
        let worktree_base = tempfile::tempdir().unwrap();
        let hooks = RecordingHooks::default();

        let created = create(
            &mut db,
            &hooks,
            worktree_base.path(),
            CreateParams {
                repo_id: &repo.id,
                name: "scratch",
                branch_prefix: "test/",
            },
        )
        .await
        .unwrap();

        assert!(
            !db.is_branch_auto_rename_claimed(&created.workspace.id)
                .unwrap()
        );
        assert!(db.claim_branch_auto_rename(&created.workspace.id).unwrap());
    }

    #[tokio::test]
    async fn create_can_preserve_supplied_name_by_claiming_auto_rename() {
        let (_repo_dir, _db_dir, mut db, repo) = setup_repo_and_db().await;
        let worktree_base = tempfile::tempdir().unwrap();
        let hooks = RecordingHooks::default();

        let created = create_preserving_supplied_name(
            &mut db,
            &hooks,
            worktree_base.path(),
            CreateParams {
                repo_id: &repo.id,
                name: "agent-pipeline",
                branch_prefix: "test/",
            },
        )
        .await
        .unwrap();

        assert_eq!(created.workspace.name, "agent-pipeline");
        assert_eq!(created.workspace.branch_name, "test/agent-pipeline");
        assert!(
            db.is_branch_auto_rename_claimed(&created.workspace.id)
                .unwrap()
        );
        assert!(!db.claim_branch_auto_rename(&created.workspace.id).unwrap());
    }

    /// Regression for the `claudette workspace archive --delete-branch`
    /// IPC flow: when the row is hard-deleted, the hook must announce
    /// `Deleted` (not `Archived`) so the frontend can `removeWorkspace`
    /// instead of marking a row that no longer exists as archived.
    #[tokio::test]
    async fn archive_emits_deleted_when_branch_deleted() {
        let (_repo_dir, _db_dir, mut db, repo) = setup_repo_and_db().await;
        let worktree_base = tempfile::tempdir().unwrap();
        let hooks = RecordingHooks::default();

        let created = create(
            &mut db,
            &hooks,
            worktree_base.path(),
            CreateParams {
                repo_id: &repo.id,
                name: "feature",
                branch_prefix: "test/",
            },
        )
        .await
        .unwrap();
        let ws_id = created.workspace.id.clone();

        archive(
            &mut db,
            &hooks,
            ArchiveParams {
                workspace_id: &ws_id,
                delete_branch: true,
            },
        )
        .await
        .unwrap();

        let kinds: Vec<_> = hooks
            .changes()
            .into_iter()
            .filter(|(id, _)| id == &ws_id)
            .map(|(_, k)| k)
            .collect();
        assert_eq!(
            kinds,
            vec![WorkspaceChangeKind::Created, WorkspaceChangeKind::Deleted],
            "delete_branch=true must emit Deleted (not Archived)"
        );
    }

    /// Standard archive (delete_branch=false) keeps the row in the DB
    /// as Archived; the hook must use `Archived` so the frontend updates
    /// the existing row instead of removing it.
    #[tokio::test]
    async fn archive_emits_archived_when_branch_kept() {
        let (_repo_dir, _db_dir, mut db, repo) = setup_repo_and_db().await;
        let worktree_base = tempfile::tempdir().unwrap();
        let hooks = RecordingHooks::default();

        let created = create(
            &mut db,
            &hooks,
            worktree_base.path(),
            CreateParams {
                repo_id: &repo.id,
                name: "feature",
                branch_prefix: "test/",
            },
        )
        .await
        .unwrap();
        let ws_id = created.workspace.id.clone();

        archive(
            &mut db,
            &hooks,
            ArchiveParams {
                workspace_id: &ws_id,
                delete_branch: false,
            },
        )
        .await
        .unwrap();

        let kinds: Vec<_> = hooks
            .changes()
            .into_iter()
            .filter(|(id, _)| id == &ws_id)
            .map(|(_, k)| k)
            .collect();
        assert_eq!(
            kinds,
            vec![WorkspaceChangeKind::Created, WorkspaceChangeKind::Archived,],
            "delete_branch=false must keep emitting Archived"
        );
    }

    /// `build_script_command` must produce a Command that actually runs
    /// the user-supplied script on the host's default shell — `sh -c` on
    /// Unix and `cmd.exe /S /C` on Windows. Before the cross-platform
    /// gating was added, every Windows host without Git Bash on PATH
    /// failed setup-script execution with an opaque ENOENT.
    ///
    /// We assert the contract end-to-end: spawn the helper with a
    /// trivial `echo` (recognised by both shells), run the command,
    /// and read the stdout the script actually produced.
    #[tokio::test]
    async fn build_script_command_executes_on_host_shell() {
        let cwd = tempfile::tempdir().unwrap();
        // `echo hello` is a builtin on both `cmd.exe` and POSIX shells,
        // so the test is independent of any external binary on PATH.
        let mut cmd = build_script_command("echo hello", cwd.path());
        let output = cmd.output().await.expect("spawn host shell");
        assert!(
            output.status.success(),
            "host shell exited non-zero: status={:?} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Trim because Windows `cmd.exe /C echo hello` emits "hello\r\n"
        // and POSIX `sh -c 'echo hello'` emits "hello\n".
        assert_eq!(
            stdout.trim(),
            "hello",
            "expected `echo hello` stdout, got {stdout:?}",
        );
    }

    /// `kill_script_subtree` must terminate a hung script's full
    /// descendant tree on Windows, not just the `cmd.exe` root. Spawn a
    /// shell with a long-lived backgrounded child (`ping -n 30`) plus an
    /// inline child (`ping -n 30`), call the helper against the root
    /// PID, and assert both root and children are gone.
    ///
    /// This is the contract the setup/archive timeout arm relies on —
    /// pre-fix the timeout only ran `child.kill()` (TerminateProcess on
    /// the immediate child) so backgrounded `npm install` workers
    /// orphaned to the desktop session.
    #[cfg(windows)]
    #[tokio::test]
    async fn kill_script_subtree_terminates_grandchildren() {
        use std::time::Duration;

        let mut child = TokioCommand::new("cmd.exe")
            .no_console_window()
            .args([
                "/C",
                "start /B ping -n 30 127.0.0.1 >NUL & ping -n 30 127.0.0.1 >NUL",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd.exe");

        let root_pid = child.id().expect("child pid");

        // Give the shell a beat to fork its descendants.
        tokio::time::sleep(Duration::from_millis(250)).await;

        kill_script_subtree(root_pid).await;

        // Wait the child handle so its in-process state matches reality.
        // `taskkill /T /F` is fast (<100ms typical), but we still bound
        // the wait so a misbehaving Windows host can't hang the suite.
        let waited = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        assert!(
            waited.is_ok(),
            "child did not exit within 5 s after kill_script_subtree"
        );

        // Spot-check the root is dead. Use the same OpenProcess probe
        // the CLI's discovery reader uses for stale-file detection so
        // the assertion exercises a path we already test elsewhere.
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, root_pid) };
        if !handle.is_null() {
            let mut code: u32 = 0;
            let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
            unsafe { CloseHandle(handle) };
            assert!(
                ok == 0 || code as i32 != STILL_ACTIVE,
                "root pid {root_pid} still STILL_ACTIVE after kill_script_subtree"
            );
        }
        // If OpenProcess returned NULL the PID is gone — that's the
        // happy case, no further assertion needed.
    }
}
