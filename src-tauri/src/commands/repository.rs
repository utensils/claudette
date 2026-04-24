use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use claudette::config;
use claudette::db::{Database, is_duplicate_repository_path_error};
use claudette::git;
use claudette::model::Repository;

use crate::state::AppState;

pub(crate) fn resolve_default_remote(remotes: &[String]) -> Option<String> {
    match remotes.len() {
        0 => None,
        1 => Some(remotes[0].clone()),
        _ => {
            if remotes.iter().any(|r| r == "origin") {
                Some("origin".to_string())
            } else {
                Some(remotes[0].clone())
            }
        }
    }
}

pub(crate) fn resolve_default_branch(
    branches: &[String],
    default_remote: Option<&str>,
) -> Option<String> {
    if branches.is_empty() {
        return None;
    }
    if branches.len() == 1 {
        return Some(branches[0].clone());
    }
    let remote = default_remote.unwrap_or("origin");
    let main = format!("{remote}/main");
    if branches.iter().any(|b| b == &main) {
        return Some(main);
    }
    let master = format!("{remote}/master");
    if branches.iter().any(|b| b == &master) {
        return Some(master);
    }
    Some(branches[0].clone())
}

#[derive(Serialize)]
pub struct RepoConfigInfo {
    pub has_config_file: bool,
    pub setup_script: Option<String>,
    pub instructions: Option<String>,
    pub parse_error: Option<String>,
}

#[tauri::command]
pub async fn add_repository(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Repository, String> {
    git::validate_repo(&path).await.map_err(|e| e.to_string())?;

    let canon = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let canon_str = canon.to_string_lossy().to_string();

    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canon_str.clone());

    let path_slug = slug_from_path(&canon_str);

    let remotes = git::list_remotes(&canon_str).await.unwrap_or_default();
    let branches = git::list_remote_tracking_branches(&canon_str)
        .await
        .unwrap_or_default();

    let default_remote = resolve_default_remote(&remotes);
    let base_branch = resolve_default_branch(&branches, default_remote.as_deref());

    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        path: canon_str,
        name,
        path_slug,
        icon: None,
        created_at: now_iso(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        base_branch,
        default_remote,
        path_valid: true,
    };

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.insert_repository(&repo).map_err(|e| {
        if is_duplicate_repository_path_error(&e) {
            "This repository is already in Claudette.".to_string()
        } else {
            e.to_string()
        }
    })?;

    crate::tray::rebuild_tray(&app);

    // Warm the env-provider cache against the repo's main checkout
    // so the first EnvPanel open doesn't pay the cold cost — and so
    // any trust issues (blocked `.envrc`, untrusted `mise.toml`) show
    // up before the user tries to spawn a workspace. Fire-and-forget
    // because a `.envrc` can prompt for `direnv allow` which takes
    // time; blocking `add_repository` on it would make the repo-add
    // UX sluggish.
    crate::commands::env::spawn_repo_env_warmup(app.clone(), repo.id.clone());

    Ok(repo)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_repository_settings(
    id: String,
    name: String,
    icon: Option<String>,
    setup_script: Option<String>,
    custom_instructions: Option<String>,
    branch_rename_preferences: Option<String>,
    setup_script_auto_run: bool,
    base_branch: Option<String>,
    default_remote: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let base_branch = base_branch.filter(|s| !s.trim().is_empty());
    let default_remote = default_remote.filter(|s| !s.trim().is_empty());

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_repository_name(&id, &name)
        .map_err(|e| e.to_string())?;
    db.update_repository_icon(&id, icon.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_setup_script(&id, setup_script.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_custom_instructions(&id, custom_instructions.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_branch_rename_preferences(&id, branch_rename_preferences.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_setup_script_auto_run(&id, setup_script_auto_run)
        .map_err(|e| e.to_string())?;
    db.update_repository_base_branch(&id, base_branch.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_default_remote(&id, default_remote.as_deref())
        .map_err(|e| e.to_string())?;

    crate::tray::rebuild_tray(&app);

    Ok(())
}

#[tauri::command]
pub async fn set_setup_script_auto_run(
    repo_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_repository_setup_script_auto_run(&repo_id, enabled)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn relink_repository(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    git::validate_repo(&path).await.map_err(|e| e.to_string())?;

    let canon = std::fs::canonicalize(&path).map_err(|e| format!("Invalid path: {e}"))?;
    let canon_str = canon.to_string_lossy().to_string();

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_repository_path(&id, &canon_str)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn remove_repository(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Find repo and its workspaces to clean up worktrees.
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == id)
        .ok_or("Repository not found")?;

    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let repo_workspaces: Vec<_> = workspaces
        .iter()
        .filter(|w| w.repository_id == id)
        .collect();

    // Remove each worktree (best-effort).
    for ws in &repo_workspaces {
        if let Some(ref wt_path) = ws.worktree_path {
            let _ = git::remove_worktree(&repo.path, wt_path, true).await;
        }
    }

    // Clean up in-memory agent sessions for this repo's workspaces
    // so the tray doesn't show stale running/attention state.
    {
        let mut agents = state.agents.write().await;
        for ws in &repo_workspaces {
            agents.remove(&ws.id);
        }
    }

    // Cascade delete handles workspaces, chat messages, terminal tabs.
    // We materialize per-workspace metric summaries first so lifetime
    // stats survive the cascade.
    db.delete_repository_with_summaries(&id)
        .map_err(|e| e.to_string())?;

    crate::tray::rebuild_tray(&app);

    Ok(())
}

/// Read .claudette.json config for a registered repository (by ID).
#[tauri::command]
pub async fn get_repo_config(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<RepoConfigInfo, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    // Run sync file I/O off the async runtime thread.
    let repo_path = repo.path.clone();
    let config_result =
        tokio::task::spawn_blocking(move || config::load_config(Path::new(&repo_path)))
            .await
            .map_err(|e| format!("Config load task failed: {e}"))?;

    match config_result {
        Ok(Some(cfg)) => Ok(RepoConfigInfo {
            has_config_file: true,
            setup_script: cfg.scripts.and_then(|s| s.setup),
            instructions: cfg.instructions,
            parse_error: None,
        }),
        Ok(None) => Ok(RepoConfigInfo {
            has_config_file: false,
            setup_script: None,
            instructions: None,
            parse_error: None,
        }),
        Err(e) => Ok(RepoConfigInfo {
            has_config_file: true,
            setup_script: None,
            instructions: None,
            parse_error: Some(e),
        }),
    }
}

/// Get the default branch for a repository (e.g., "main" or "master").
#[tauri::command]
pub async fn get_default_branch(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    if let Some(ref base) = repo.base_branch {
        return Ok(Some(base.clone()));
    }

    match git::default_branch(&repo.path, repo.default_remote.as_deref()).await {
        Ok(branch) => Ok(Some(branch)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn list_git_remotes(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(&repo_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    git::list_remotes(&repo.path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_git_remote_branches(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(&repo_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    git::list_remote_tracking_branches(&repo.path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_repositories(
    ids: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.reorder_repositories(&ids).map_err(|e| e.to_string())?;
    crate::tray::rebuild_tray(&app);
    Ok(())
}

fn slug_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string())
}

fn now_iso() -> String {
    // Simple UTC timestamp without pulling in chrono.
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
