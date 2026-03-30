use std::path::PathBuf;

use tauri::State;

use claudette::db::Database;
use claudette::git;
use claudette::model::{AgentStatus, Workspace, WorkspaceStatus};
use claudette::names::NameGenerator;

use crate::state::AppState;

#[tauri::command]
pub async fn create_workspace(
    repo_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    // Validate workspace name.
    let forbidden = ['/', '\\', ':', '?', '*', '[', ' ', '~', '.'];
    if name.is_empty() || name.chars().any(|c| forbidden.contains(&c)) || name.ends_with(".lock") {
        return Err(format!("Invalid workspace name: '{name}'"));
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == repo_id)
        .ok_or("Repository not found")?;

    let branch_name = format!("claudette/{name}");
    let worktree_base = state.worktree_base_dir.read().await;
    let worktree_path: PathBuf = worktree_base.join(&repo.path_slug).join(&name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let actual_path = git::create_worktree(&repo.path, &branch_name, &worktree_path_str)
        .await
        .map_err(|e| e.to_string())?;

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: repo_id,
        name,
        branch_name,
        worktree_path: Some(actual_path),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: now_iso(),
    };

    db.insert_workspace(&ws).map_err(|e| e.to_string())?;

    Ok(ws)
}

#[tauri::command]
pub async fn archive_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
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
        let _ = git::remove_worktree(&repo.path, wt_path).await;
    }

    db.delete_terminal_tabs_for_workspace(&id)
        .map_err(|e| e.to_string())?;
    db.update_workspace_status(&id, &WorkspaceStatus::Archived, None)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn restore_workspace(id: String, state: State<'_, AppState>) -> Result<String, String> {
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

    Ok(actual_path)
}

#[tauri::command]
pub async fn delete_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
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

    // Remove worktree if active.
    if let Some(ref wt_path) = ws.worktree_path {
        let _ = git::remove_worktree(&repo.path, wt_path).await;
    }

    // Best-effort branch delete.
    let _ = git::branch_delete(&repo.path, &ws.branch_name).await;

    // Cascade deletes chat messages and terminal tabs.
    db.delete_workspace(&id).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn generate_workspace_name() -> String {
    NameGenerator::new().generate().display
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

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
