use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use claudette::db::Database;
use claudette::git;
use claudette::model::{ChatMessage, Repository, Workspace};

use crate::state::AppState;

#[derive(Serialize)]
pub struct InitialData {
    pub repositories: Vec<Repository>,
    pub workspaces: Vec<Workspace>,
    pub worktree_base_dir: String,
    /// Maps repo ID → default branch name (e.g., "main", "master").
    pub default_branches: HashMap<String, String>,
    /// Most recent chat message per workspace (for dashboard display).
    pub last_messages: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn load_initial_data(state: State<'_, AppState>) -> Result<InitialData, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let repositories = db.list_repositories().map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    let worktree_base_dir = {
        let dir = state.worktree_base_dir.read().await;
        dir.to_string_lossy().to_string()
    };

    // Check which repo paths are still valid on disk.
    let repositories: Vec<Repository> = repositories
        .into_iter()
        .map(|mut r| {
            r.path_valid = std::path::Path::new(&r.path).is_dir();
            r
        })
        .collect();

    // Resolve default branch for each valid repo concurrently (best-effort).
    let branch_futures: Vec<_> = repositories
        .iter()
        .filter(|r| r.path_valid)
        .map(|r| {
            let id = r.id.clone();
            let path = r.path.clone();
            async move { git::default_branch(&path).await.ok().map(|b| (id, b)) }
        })
        .collect();
    let branch_results = futures::future::join_all(branch_futures).await;
    let default_branches: HashMap<String, String> = branch_results.into_iter().flatten().collect();

    // Resolve current branch for each workspace worktree.
    let workspace_branch_futures: Vec<_> = workspaces
        .iter()
        .filter_map(|ws| {
            ws.worktree_path.as_ref().map(|path| {
                let id = ws.id.clone();
                let path = path.clone();
                async move { git::current_branch(&path).await.ok().map(|b| (id, b)) }
            })
        })
        .collect();
    let workspace_branch_results = futures::future::join_all(workspace_branch_futures).await;
    let workspace_current_branches: HashMap<String, String> =
        workspace_branch_results.into_iter().flatten().collect();

    // Update workspace branch_name with current branch from worktree.
    let workspaces: Vec<Workspace> = workspaces
        .into_iter()
        .map(|mut ws| {
            if let Some(current) = workspace_current_branches.get(&ws.id) {
                ws.branch_name = current.clone();
            }
            ws
        })
        .collect();

    let last_messages = db.last_message_per_workspace().map_err(|e| e.to_string())?;

    Ok(InitialData {
        repositories,
        workspaces,
        worktree_base_dir,
        default_branches,
        last_messages,
    })
}
