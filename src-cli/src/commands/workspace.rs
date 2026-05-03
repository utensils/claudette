//! `claudette workspace …` — workspace lifecycle subcommands.
//!
//! Each action maps to one IPC call. The CLI doesn't open the SQLite
//! database directly so the GUI's tray, notifications, and event
//! subscribers stay consistent — every change flows through the
//! `claudette::ops::*` surface the GUI itself dispatches into.

use std::error::Error;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List active workspaces. Pair with `--json` for scripting.
    List,
    /// Create a new workspace in the named repository.
    Create {
        /// Repository ID. Get one from `claudette rpc list_repositories`.
        repo: String,
        /// Workspace name. Letters, numbers, and hyphens only.
        name: String,
    },
    /// Archive a workspace. Worktree is removed; chat history is preserved.
    Archive {
        /// Workspace ID.
        id: String,
        /// Also delete the workspace's branch (matches the GUI's
        /// `git_delete_branch_on_archive` setting).
        #[arg(long)]
        delete_branch: bool,
    },
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List => {
            let value = ipc::call(&info, "list_workspaces", serde_json::json!({})).await?;
            if json {
                output::print_json(&value)?;
            } else {
                render_workspace_table(&value);
            }
        }
        Action::Create { repo, name } => {
            let value = ipc::call(
                &info,
                "create_workspace",
                serde_json::json!({ "repo_id": repo, "name": name }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Archive { id, delete_branch } => {
            let value = ipc::call(
                &info,
                "archive_workspace",
                serde_json::json!({
                    "workspace_id": id,
                    "delete_branch": delete_branch,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
    }
    Ok(())
}

/// Minimal table renderer for `workspace list`. Format is intentionally
/// simple — we'll switch to a real table crate (`tabled`?) when more
/// commands need column-aware rendering.
fn render_workspace_table(value: &serde_json::Value) {
    let Some(items) = value.as_array() else {
        eprintln!("(unexpected response shape — try --json)");
        return;
    };
    if items.is_empty() {
        println!("no workspaces");
        return;
    }
    println!("{:<36}  {:<24}  {:<10}  BRANCH", "ID", "NAME", "STATUS");
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("?");
        let branch = item
            .get("branch_name")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        println!("{id:<36}  {name:<24}  {status:<10}  {branch}");
    }
}
