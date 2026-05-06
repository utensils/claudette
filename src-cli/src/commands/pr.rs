//! `claudette pr …` — friendly shortcut over the active SCM provider
//! plugin (typically `scm-github` or `scm-gitlab`).
//!
//! Resolves the workspace from `--workspace` / `$CLAUDETTE_WORKSPACE_ID`,
//! asks the GUI which SCM provider handles that workspace's repository,
//! then dispatches the matching plugin operation. If no provider is
//! configured (no SCM plugin matches the remote URL, or the required
//! CLI is missing), the command exits with a helpful error.
//!
//! Three IPC round-trips per command — `list_workspaces` to resolve the
//! workspace's repo + branch, `scm.detect_provider` to find the matching
//! plugin, and `plugin.invoke` to dispatch the operation. Cheap on a
//! local socket.

use std::error::Error;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List pull requests for the current workspace's branch (or all
    /// open PRs in the repo when `--all` is set).
    List {
        /// Workspace ID — defaults to `$CLAUDETTE_WORKSPACE_ID`.
        #[arg(long, env = "CLAUDETTE_WORKSPACE_ID")]
        workspace: String,
        /// List every open PR in the repo, not just those for this branch.
        #[arg(long)]
        all: bool,
    },
    /// Show one pull request by number.
    Show {
        /// PR number.
        number: u64,
        /// Workspace ID — defaults to `$CLAUDETTE_WORKSPACE_ID`.
        #[arg(long, env = "CLAUDETTE_WORKSPACE_ID")]
        workspace: String,
    },
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List { workspace, all } => {
            let resolved = resolve_workspace(&info, &workspace).await?;
            let value = ipc::call(
                &info,
                "plugin.invoke",
                serde_json::json!({
                    "plugin": resolved.provider,
                    "operation": "list_pull_requests",
                    "workspace_id": workspace,
                    "args": {},
                }),
            )
            .await?;
            let prs = filter_prs(value, &resolved.branch_name, all);
            if json {
                output::print_json(&prs)?;
            } else {
                render_pr_table(&prs);
            }
        }
        Action::Show { number, workspace } => {
            let resolved = resolve_workspace(&info, &workspace).await?;
            let value = ipc::call(
                &info,
                "plugin.invoke",
                serde_json::json!({
                    "plugin": resolved.provider,
                    "operation": "get_pull_request",
                    "workspace_id": workspace,
                    "args": { "number": number },
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
    }
    Ok(())
}

/// Everything `pr` commands need to look up about the workspace before
/// dispatching the plugin operation: the SCM provider name, the
/// workspace's branch, and (currently unused but cheap to expose) the
/// repository id. One `list_workspaces` round-trip plus one
/// `scm.detect_provider` round-trip — keeping the two split lets
/// `claudette plugin invoke scm.detect_provider …` callers reuse the
/// same IPC method directly.
struct ResolvedWorkspace {
    provider: String,
    branch_name: String,
}

async fn resolve_workspace(
    info: &crate::discovery::AppInfo,
    workspace_id: &str,
) -> Result<ResolvedWorkspace, Box<dyn Error>> {
    let value = ipc::call(info, "list_workspaces", serde_json::json!({})).await?;
    let items = value.as_array().ok_or("unexpected list_workspaces shape")?;
    let ws = items
        .iter()
        .find(|w| w.get("id").and_then(|v| v.as_str()) == Some(workspace_id))
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_id = ws
        .get("repository_id")
        .and_then(|v| v.as_str())
        .ok_or("workspace missing repository_id")?
        .to_string();
    let branch_name = ws
        .get("branch_name")
        .and_then(|v| v.as_str())
        .ok_or("workspace missing branch_name")?
        .to_string();
    let detect = ipc::call(
        info,
        "scm.detect_provider",
        serde_json::json!({ "repo_id": repo_id }),
    )
    .await?;
    let provider = detect
        .get("provider")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| -> Box<dyn Error> {
            "no SCM provider matches this repository (check `claudette plugin list` \
             — the matching plugin's CLI may be missing or disabled)"
                .into()
        })?;
    Ok(ResolvedWorkspace {
        provider,
        branch_name,
    })
}

/// `list_pull_requests` returns every PR the provider knows about; the
/// GUI's `load_scm_detail` picks the one matching the workspace branch.
/// We do the same here unless `--all` is set so the default is "PRs
/// relevant to my current workspace." Pure filter — no IPC round-trip.
fn filter_prs(value: serde_json::Value, branch_name: &str, all: bool) -> serde_json::Value {
    if all {
        return value;
    }
    let Some(items) = value.as_array() else {
        return value;
    };
    let filtered: Vec<serde_json::Value> = items
        .iter()
        .filter(|pr| pr.get("branch").and_then(|v| v.as_str()) == Some(branch_name))
        .cloned()
        .collect();
    serde_json::Value::Array(filtered)
}

fn render_pr_table(value: &serde_json::Value) {
    let Some(items) = value.as_array() else {
        eprintln!("(unexpected response shape — try --json)");
        return;
    };
    if items.is_empty() {
        println!("no pull requests");
        return;
    }
    println!("{:<6}  {:<8}  {:<10}  TITLE", "#", "STATE", "BRANCH");
    for pr in items {
        let number = pr
            .get("number")
            .and_then(|v| v.as_u64())
            .map(|n| n.to_string())
            .unwrap_or_else(|| "?".into());
        let state = pr.get("state").and_then(|v| v.as_str()).unwrap_or("?");
        let branch = pr.get("branch").and_then(|v| v.as_str()).unwrap_or("?");
        let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("?");
        println!("{number:<6}  {state:<8}  {branch:<10}  {title}");
    }
}
