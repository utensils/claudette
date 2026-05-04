//! `claudette pr …` — friendly shortcut over the active SCM provider
//! plugin (typically `scm-github` or `scm-gitlab`).
//!
//! Resolves the workspace from `--workspace` / `$CLAUDETTE_WORKSPACE_ID`,
//! asks the GUI which SCM provider handles that workspace's repository,
//! then dispatches the matching plugin operation. If no provider is
//! configured (no SCM plugin matches the remote URL, or the required
//! CLI is missing), the command exits with a helpful error.
//!
//! Two IPC round-trips per command — one to resolve the provider, one
//! to invoke the plugin operation. Cheap on a local socket.

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
            let provider = resolve_provider(&info, &workspace).await?;
            let value = ipc::call(
                &info,
                "plugin.invoke",
                serde_json::json!({
                    "plugin": provider,
                    "operation": "list_pull_requests",
                    "workspace_id": workspace,
                    "args": {},
                }),
            )
            .await?;
            let prs = filter_prs(value, &info, &workspace, all).await?;
            if json {
                output::print_json(&prs)?;
            } else {
                render_pr_table(&prs);
            }
        }
        Action::Show { number, workspace } => {
            let provider = resolve_provider(&info, &workspace).await?;
            let value = ipc::call(
                &info,
                "plugin.invoke",
                serde_json::json!({
                    "plugin": provider,
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

/// Two-step provider resolution: read the workspace's repo_id, then ask
/// the GUI to detect the provider for that repo. We could collapse this
/// into one IPC method but keeping them split lets `claudette plugin`
/// callers reuse `scm.detect_provider` directly.
async fn resolve_provider(
    info: &crate::discovery::AppInfo,
    workspace_id: &str,
) -> Result<String, Box<dyn Error>> {
    let repo_id = lookup_repo_id(info, workspace_id).await?;
    let detect = ipc::call(
        info,
        "scm.detect_provider",
        serde_json::json!({ "repo_id": repo_id }),
    )
    .await?;
    detect
        .get("provider")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| {
            "no SCM provider matches this repository (check `claudette plugin list` \
             — the matching plugin's CLI may be missing or disabled)"
                .into()
        })
}

async fn lookup_repo_id(
    info: &crate::discovery::AppInfo,
    workspace_id: &str,
) -> Result<String, Box<dyn Error>> {
    let value = ipc::call(info, "list_workspaces", serde_json::json!({})).await?;
    let items = value.as_array().ok_or("unexpected list_workspaces shape")?;
    let ws = items
        .iter()
        .find(|w| w.get("id").and_then(|v| v.as_str()) == Some(workspace_id))
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    ws.get("repository_id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "workspace missing repository_id".into())
}

/// `list_pull_requests` returns every PR the provider knows about; the
/// GUI's `load_scm_detail` picks the one matching the workspace branch.
/// We do the same here unless `--all` is set so the default is "PRs
/// relevant to my current workspace."
async fn filter_prs(
    value: serde_json::Value,
    info: &crate::discovery::AppInfo,
    workspace_id: &str,
    all: bool,
) -> Result<serde_json::Value, Box<dyn Error>> {
    if all {
        return Ok(value);
    }
    let branch = lookup_branch(info, workspace_id).await?;
    let Some(items) = value.as_array() else {
        return Ok(value);
    };
    let filtered: Vec<serde_json::Value> = items
        .iter()
        .filter(|pr| pr.get("branch").and_then(|v| v.as_str()) == Some(branch.as_str()))
        .cloned()
        .collect();
    Ok(serde_json::Value::Array(filtered))
}

async fn lookup_branch(
    info: &crate::discovery::AppInfo,
    workspace_id: &str,
) -> Result<String, Box<dyn Error>> {
    let value = ipc::call(info, "list_workspaces", serde_json::json!({})).await?;
    let items = value.as_array().ok_or("unexpected list_workspaces shape")?;
    let ws = items
        .iter()
        .find(|w| w.get("id").and_then(|v| v.as_str()) == Some(workspace_id))
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    ws.get("branch_name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "workspace missing branch_name".into())
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
