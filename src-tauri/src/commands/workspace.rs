use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command as TokioCommand;

use claudette::agent;
use claudette::config;
use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::git;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::model::{AgentStatus, Workspace, WorkspaceStatus};
use claudette::names::NameGenerator;

use crate::state::AppState;

#[derive(Serialize, Clone)]
pub struct SetupResult {
    pub source: String,
    pub script: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
}

#[derive(Serialize)]
pub struct CreateWorkspaceResult {
    pub workspace: Workspace,
    pub setup_result: Option<SetupResult>,
}

/// Read branch prefix settings from DB (sync).
pub(crate) fn read_branch_prefix_settings(db: &Database) -> (String, String) {
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

/// Resolve the branch prefix from pre-read settings (async, no DB borrow).
pub(crate) async fn resolve_branch_prefix(mode: &str, custom: &str) -> String {
    match mode {
        "custom" => {
            let sanitized = custom
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
        _ => {
            // "username" mode — read git config user.name
            match git::get_git_username().await {
                Ok(Some(name)) => {
                    let slug = agent::sanitize_branch_name(&name, 30);
                    if slug.is_empty() {
                        "claudette/".to_string()
                    } else {
                        format!("{slug}/")
                    }
                }
                _ => "claudette/".to_string(),
            }
        }
    }
}

#[tauri::command]
pub async fn create_workspace(
    repo_id: String,
    name: String,
    skip_setup: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CreateWorkspaceResult, String> {
    // Validate workspace name: must be ASCII alphanumeric + hyphens only (branch-safe).
    if name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err(format!("Invalid workspace name: '{name}'"));
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    // Capture setup script info before moving repo fields.
    let repo_path = repo.path.clone();
    let settings_setup_script = repo.setup_script.clone();

    let (prefix_mode, prefix_custom) = read_branch_prefix_settings(&db);
    let prefix = resolve_branch_prefix(&prefix_mode, &prefix_custom).await;
    let branch_name = format!("{prefix}{name}");
    let worktree_base = state.worktree_base_dir.read().await;
    let worktree_path: PathBuf = worktree_base.join(&repo.path_slug).join(&name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let actual_path = git::create_worktree(&repo_path, &branch_name, &worktree_path_str)
        .await
        .map_err(|e| e.to_string())?;

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: repo_id,
        name,
        branch_name,
        worktree_path: Some(actual_path.clone()),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: now_iso(),
    };

    db.insert_workspace(&ws).map_err(|e| e.to_string())?;

    // Resolve and execute setup script (unless caller requested skip).
    let setup_result = if skip_setup.unwrap_or(false) {
        None
    } else {
        let default_branch = git::default_branch(&repo_path)
            .await
            .unwrap_or_else(|_| "main".to_string());
        let ws_env = WorkspaceEnv::from_workspace(&ws, &repo_path, default_branch);
        resolve_and_run_setup(
            Path::new(&repo_path),
            Path::new(&actual_path),
            settings_setup_script.as_deref(),
            &ws_env,
        )
        .await
    };

    crate::tray::rebuild_tray(&app);

    Ok(CreateWorkspaceResult {
        workspace: ws,
        setup_result,
    })
}

/// Resolve the setup script from .claudette.json or settings fallback, then execute it.
async fn resolve_and_run_setup(
    repo_path: &Path,
    worktree_path: &Path,
    settings_script: Option<&str>,
    ws_env: &WorkspaceEnv,
) -> Option<SetupResult> {
    // 1. Check .claudette.json
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
            // Malformed .claudette.json — warn but fall back to settings script.
            eprintln!("[setup] {parse_err}");
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

    // 2. Execute the script in its own process group so we can kill the
    //    entire tree on timeout (prevents orphan grandchild processes).
    let mut cmd = TokioCommand::new("sh");
    cmd.arg("-c")
        .arg(&script)
        .current_dir(worktree_path)
        .env("PATH", claudette::env::enriched_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0);
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

    // 3. Read stdout/stderr concurrently with waiting to avoid pipe buffer
    //    deadlocks (OS pipe buffers are ~64KB — scripts like `npm install`
    //    easily exceed that).
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

    match tokio::time::timeout(Duration::from_secs(300), child.wait()).await {
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
            // Timeout — kill the entire process group, then reap the child.
            if let Some(pgid) = pid {
                unsafe {
                    libc::kill(-(pgid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await; // reap to avoid zombie
            Some(SetupResult {
                source: source.to_string(),
                script,
                output: "Setup script timed out after 5 minutes".to_string(),
                exit_code: None,
                success: false,
                timed_out: true,
            })
        }
    }
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

    let default_branch = git::default_branch(&repo.path)
        .await
        .unwrap_or_else(|_| "main".to_string());
    let ws_env = WorkspaceEnv::from_workspace(ws, &repo.path, default_branch);

    let result = resolve_and_run_setup(
        Path::new(&repo.path),
        Path::new(worktree_path),
        repo.setup_script.as_deref(),
        &ws_env,
    )
    .await;

    Ok(result)
}

#[tauri::command]
pub async fn archive_workspace(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
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

    if let Some(ref wt_path) = ws.worktree_path {
        let _ = git::remove_worktree(&repo.path, wt_path, false).await;
    }

    // Optionally delete the branch if the user has enabled this setting.
    let delete_branch = db
        .get_app_setting("git_delete_branch_on_archive")
        .ok()
        .flatten()
        .as_deref()
        == Some("true");
    if delete_branch {
        let _ = git::branch_delete(&repo.path, &ws.branch_name).await;
    }

    // Stop any running agent and clear session so tray state stays consistent.
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.remove(&id)
            && let Some(pid) = session.active_pid
        {
            let _ = claudette::agent::stop_agent(pid).await;
        }
    }

    db.delete_terminal_tabs_for_workspace(&id)
        .map_err(|e| e.to_string())?;
    db.update_workspace_status(&id, &WorkspaceStatus::Archived, None)
        .map_err(|e| e.to_string())?;

    crate::tray::rebuild_tray(&app);

    Ok(())
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
    let ws = workspaces
        .iter()
        .find(|w| w.id == id)
        .ok_or("Workspace not found")?;

    let repo_id = ws.repository_id.clone();

    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    // Stop any running agent and clear session so tray state stays consistent.
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.remove(&id)
            && let Some(pid) = session.active_pid
        {
            let _ = claudette::agent::stop_agent(pid).await;
        }
    }

    // Remove worktree if active.
    if let Some(ref wt_path) = ws.worktree_path {
        let _ = git::remove_worktree(&repo.path, wt_path, true).await;
    }

    // Best-effort branch delete. Force-deletes even if unmerged commits exist.
    let _ = git::branch_delete(&repo.path, &ws.branch_name).await;

    // Cascade deletes chat messages and terminal tabs.
    db.delete_workspace(&id).map_err(|e| e.to_string())?;

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

#[tauri::command]
pub async fn refresh_branches(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    let mut updates = Vec::new();

    for ws in &workspaces {
        if ws.status != WorkspaceStatus::Active {
            continue;
        }
        if let Some(ref wt_path) = ws.worktree_path
            && let Ok(branch) = git::current_branch(wt_path).await
            && branch != ws.branch_name
        {
            updates.push((ws.id.clone(), branch));
        }
    }

    Ok(updates)
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
