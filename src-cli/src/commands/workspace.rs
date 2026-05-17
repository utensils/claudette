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
        /// Force delete the workspace's branch on archive (overrides the
        /// GUI's `git_delete_branch_on_archive` setting). Pair: pass
        /// `--no-delete-branch` to force the branch to stay even when
        /// the GUI setting is on. Omit both to defer to the GUI setting.
        #[arg(long, overrides_with = "no_delete_branch")]
        delete_branch: bool,
        #[arg(
            long = "no-delete-branch",
            overrides_with = "delete_branch",
            hide = true
        )]
        no_delete_branch: bool,
    },
    /// Hard-delete archived workspaces in bulk. Removes worktrees,
    /// branches, and chat history; lifetime metrics are preserved in
    /// `deleted_workspace_summaries`. Active workspaces are never
    /// touched — the IPC handler rejects any non-Archived ID.
    Purge {
        /// Restrict the purge to workspaces in this repository ID. Get
        /// one from `claudette repo list`.
        #[arg(long)]
        repo: String,
        /// Only purge workspaces older than N days (measured from
        /// `created_at`). Omit to purge every archived workspace in
        /// the repo.
        #[arg(long)]
        older_than_days: Option<u32>,
        /// Print the resolved ID list without deleting anything.
        #[arg(long)]
        dry_run: bool,
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
                serde_json::json!({
                    "repo_id": repo,
                    "name": name,
                    "preserve_name": true,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Archive {
            id,
            delete_branch,
            no_delete_branch,
        } => {
            // Tri-state: only forward an override when the user
            // explicitly asked. The IPC handler treats presence as an
            // override of `git_delete_branch_on_archive`, so omitting
            // the field defers to the GUI setting.
            let override_value = if delete_branch {
                Some(true)
            } else if no_delete_branch {
                Some(false)
            } else {
                None
            };
            let mut params = serde_json::json!({ "workspace_id": id });
            if let Some(v) = override_value {
                params["delete_branch"] = serde_json::Value::Bool(v);
            }
            let value = ipc::call(&info, "archive_workspace", params).await?;
            output::print_json(&value)?;
        }
        Action::Purge {
            repo,
            older_than_days,
            dry_run,
        } => {
            let workspaces = ipc::call(&info, "list_workspaces", serde_json::json!({})).await?;
            let ids = resolve_purge_ids(&workspaces, &repo, older_than_days)?;

            if dry_run {
                if json {
                    output::print_json(&serde_json::json!({
                        "dry_run": true,
                        "ids": ids,
                    }))?;
                } else if ids.is_empty() {
                    println!("no archived workspaces match");
                } else {
                    println!("would delete {} workspace(s):", ids.len());
                    for id in &ids {
                        println!("  {id}");
                    }
                }
                return Ok(());
            }

            if ids.is_empty() {
                if json {
                    output::print_json(&serde_json::json!({
                        "deleted": [],
                        "failed": [],
                    }))?;
                } else {
                    println!("no archived workspaces match");
                }
                return Ok(());
            }

            let value = ipc::call(
                &info,
                "delete_workspaces_bulk",
                serde_json::json!({ "ids": ids }),
            )
            .await?;
            output::print_json(&value)?;
        }
    }
    Ok(())
}

/// Filter the `list_workspaces` response to archived rows matching the
/// CLI's `--repo` (required) and `--older-than-days` (optional) filters.
/// `created_at` is a Unix-seconds-as-string field (`now_iso()` in
/// `ops::workspace`); we parse it as an integer and compare against the
/// current epoch. Rows with malformed timestamps are skipped from age
/// filtering (kept if no age filter, dropped if `--older-than-days` set).
fn resolve_purge_ids(
    value: &serde_json::Value,
    repo_id: &str,
    older_than_days: Option<u32>,
) -> Result<Vec<String>, Box<dyn Error>> {
    let items = value
        .as_array()
        .ok_or("unexpected list_workspaces response shape")?;

    let cutoff_secs = older_than_days.map(|days| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        now.saturating_sub(u64::from(days) * 86_400)
    });

    let mut out = Vec::new();
    for item in items {
        let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if status != "Archived" {
            continue;
        }
        let row_repo = item
            .get("repository_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if row_repo != repo_id {
            continue;
        }
        if let Some(cutoff) = cutoff_secs {
            let created_secs = item
                .get("created_at")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok());
            match created_secs {
                Some(c) if c <= cutoff => {}
                _ => continue,
            }
        }
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push(id.to_string());
    }
    Ok(out)
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
