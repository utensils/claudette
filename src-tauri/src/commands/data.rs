use serde::Serialize;
use tauri::State;

use claudette::db::Database;
use claudette::model::{Repository, Workspace};

use crate::state::AppState;

#[derive(Serialize)]
pub struct InitialData {
    pub repositories: Vec<Repository>,
    pub workspaces: Vec<Workspace>,
    pub worktree_base_dir: String,
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
    let repositories = repositories
        .into_iter()
        .map(|mut r| {
            r.path_valid = std::path::Path::new(&r.path).is_dir();
            r
        })
        .collect();

    Ok(InitialData {
        repositories,
        workspaces,
        worktree_base_dir,
    })
}
