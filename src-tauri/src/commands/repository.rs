use std::path::Path;

use serde::Serialize;
use tauri::State;

use claudette::config;
use claudette::db::Database;
use claudette::git;
use claudette::model::Repository;

use crate::state::AppState;

#[derive(Serialize)]
pub struct RepoConfigInfo {
    pub has_config_file: bool,
    pub setup_script: Option<String>,
    pub parse_error: Option<String>,
}

#[tauri::command]
pub async fn add_repository(
    path: String,
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

    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        path: canon_str,
        name,
        path_slug,
        icon: None,
        created_at: now_iso(),
        setup_script: None,
        path_valid: true,
    };

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.insert_repository(&repo).map_err(|e| e.to_string())?;

    Ok(repo)
}

#[tauri::command]
pub async fn update_repository_settings(
    id: String,
    name: String,
    icon: Option<String>,
    setup_script: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_repository_name(&id, &name)
        .map_err(|e| e.to_string())?;
    db.update_repository_icon(&id, icon.as_deref())
        .map_err(|e| e.to_string())?;
    db.update_repository_setup_script(&id, setup_script.as_deref())
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
pub async fn remove_repository(id: String, state: State<'_, AppState>) -> Result<(), String> {
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
            let _ = git::remove_worktree(&repo.path, wt_path).await;
        }
    }

    // Cascade delete handles workspaces, chat messages, terminal tabs.
    db.delete_repository(&id).map_err(|e| e.to_string())?;

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

    match config::load_config(Path::new(&repo.path)) {
        Ok(Some(cfg)) => Ok(RepoConfigInfo {
            has_config_file: true,
            setup_script: cfg.scripts.and_then(|s| s.setup),
            parse_error: None,
        }),
        Ok(None) => Ok(RepoConfigInfo {
            has_config_file: false,
            setup_script: None,
            parse_error: None,
        }),
        Err(e) => Ok(RepoConfigInfo {
            has_config_file: true,
            setup_script: None,
            parse_error: Some(e),
        }),
    }
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
