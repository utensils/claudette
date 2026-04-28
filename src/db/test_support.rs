//! Shared test fixtures for `db` submodule tests.
//!
//! Each domain module's `mod tests` imports from here so we don't duplicate
//! the same `make_*` helpers across files.

#![cfg(test)]

use crate::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};

use super::Database;

pub(crate) fn make_repo(id: &str, path: &str, name: &str) -> Repository {
    Repository {
        id: id.into(),
        path: path.into(),
        name: name.into(),
        path_slug: name.into(),
        icon: None,
        created_at: String::new(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        base_branch: None,
        default_remote: None,
        path_valid: true,
    }
}

pub(crate) fn make_workspace(id: &str, repo_id: &str, name: &str) -> Workspace {
    Workspace {
        id: id.into(),
        repository_id: repo_id.into(),
        name: name.into(),
        branch_name: format!("claudette/{name}"),
        worktree_path: None,
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: String::new(),
    }
}

pub(crate) fn setup_db_with_workspace() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
        .unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
        .unwrap();
    db
}
