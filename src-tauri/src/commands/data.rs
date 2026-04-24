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
    let mut repositories: Vec<Repository> = repositories
        .into_iter()
        .map(|mut r| {
            r.path_valid = std::path::Path::new(&r.path).is_dir();
            r
        })
        .collect();

    // Backfill repos that have no default_remote or base_branch set.
    let needs_backfill: Vec<_> = repositories
        .iter()
        .filter(|r| r.path_valid && (r.default_remote.is_none() || r.base_branch.is_none()))
        .map(|r| {
            (
                r.id.clone(),
                r.path.clone(),
                r.default_remote.clone(),
                r.base_branch.clone(),
            )
        })
        .collect();

    if !needs_backfill.is_empty() {
        use super::repository::{resolve_default_branch, resolve_default_remote};

        let backfill_futures: Vec<_> = needs_backfill
            .into_iter()
            .map(|(id, path, existing_remote, existing_branch)| async move {
                let remote = match existing_remote {
                    Some(r) => Some(r),
                    None => {
                        let remotes = git::list_remotes(&path).await.unwrap_or_default();
                        resolve_default_remote(&remotes)
                    }
                };
                let branch = match existing_branch {
                    Some(b) => Some(b),
                    None => {
                        let branches = git::list_remote_tracking_branches(&path)
                            .await
                            .unwrap_or_default();
                        resolve_default_branch(&branches, remote.as_deref())
                    }
                };
                (id, remote, branch)
            })
            .collect();

        let results = futures::future::join_all(backfill_futures).await;
        let db2 = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        for (id, remote, branch) in &results {
            if let Some(r) = remote {
                let _ = db2.update_repository_default_remote(id, Some(r));
            }
            if let Some(b) = branch {
                let _ = db2.update_repository_base_branch(id, Some(b));
            }
            if let Some(repo) = repositories.iter_mut().find(|r| r.id == *id) {
                if repo.default_remote.is_none() {
                    repo.default_remote.clone_from(remote);
                }
                if repo.base_branch.is_none() {
                    repo.base_branch.clone_from(branch);
                }
            }
        }
    }

    // Resolve default branch for each valid repo concurrently (best-effort).
    let branch_futures: Vec<_> = repositories
        .iter()
        .filter(|r| r.path_valid)
        .map(|r| {
            let id = r.id.clone();
            let path = r.path.clone();
            let base = r.base_branch.clone();
            let remote = r.default_remote.clone();
            async move {
                let branch = match base {
                    Some(b) => Some(b),
                    None => git::default_branch(&path, remote.as_deref()).await.ok(),
                };
                branch.map(|b| (id, b))
            }
        })
        .collect();
    let branch_results = futures::future::join_all(branch_futures).await;
    let default_branches: HashMap<String, String> = branch_results.into_iter().flatten().collect();

    // Resolve current branch for each active workspace with a valid worktree path.
    let workspace_branch_futures: Vec<_> = workspaces
        .iter()
        .filter(|ws| ws.status == claudette::model::WorkspaceStatus::Active)
        .filter_map(|ws| {
            ws.worktree_path
                .as_ref()
                .filter(|path| std::path::Path::new(path).is_dir())
                .map(|path| {
                    let id = ws.id.clone();
                    let path = path.clone();
                    async move {
                        match git::current_branch(&path).await {
                            Ok(branch) => (id, branch),
                            Err(_) => (id, "(detached)".to_string()),
                        }
                    }
                })
        })
        .collect();
    let workspace_branch_results = futures::future::join_all(workspace_branch_futures).await;
    let workspace_current_branches: HashMap<String, String> =
        workspace_branch_results.into_iter().collect();

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
