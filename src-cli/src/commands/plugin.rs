//! `claudette plugin …` — generic surface over the running GUI's
//! `PluginRegistry`. Lets scripts inspect which plugins are loaded and
//! invoke any declared operation directly.
//!
//! Friendly per-kind shortcuts (e.g. `claudette pr list`) live in their
//! own modules; this surface is the lowest-common-denominator escape
//! hatch — useful for plugins that don't have first-class CLI support
//! and for debugging plugin authors.

use std::error::Error;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List loaded plugins with their kind, operations, and CLI status.
    /// Pair with `--json` for scripting.
    List,
    /// Invoke a plugin operation directly. Requires a workspace context
    /// because plugin operations resolve paths relative to a worktree;
    /// pass `--workspace` or set `CLAUDETTE_WORKSPACE_ID`.
    ///
    /// Example:
    ///   claudette plugin invoke github list_pull_requests \
    ///       --workspace ws-abc \
    ///       '{"branch":"feature/x"}'
    Invoke {
        /// Plugin name (the `name` field in `plugin.json`).
        plugin: String,
        /// Operation name. Must appear in the plugin manifest's
        /// `operations` list.
        operation: String,
        /// JSON-encoded args object passed verbatim to the operation.
        /// Defaults to `{}`.
        #[arg(default_value = "{}")]
        args: String,
        /// Workspace ID — defaults to `$CLAUDETTE_WORKSPACE_ID`.
        #[arg(long, env = "CLAUDETTE_WORKSPACE_ID")]
        workspace: String,
    },
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List => {
            let value = ipc::call(&info, "plugin.list", serde_json::json!({})).await?;
            if json {
                output::print_json(&value)?;
            } else {
                render_plugin_table(&value);
            }
        }
        Action::Invoke {
            plugin,
            operation,
            args,
            workspace,
        } => {
            let parsed_args: serde_json::Value = serde_json::from_str(&args)
                .map_err(|e| format!("--args is not valid JSON: {e}"))?;
            let value = ipc::call(
                &info,
                "plugin.invoke",
                serde_json::json!({
                    "plugin": plugin,
                    "operation": operation,
                    "workspace_id": workspace,
                    "args": parsed_args,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
    }
    Ok(())
}

fn render_plugin_table(value: &serde_json::Value) {
    let Some(items) = value.as_array() else {
        eprintln!("(unexpected response shape — try --json)");
        return;
    };
    if items.is_empty() {
        println!("no plugins loaded");
        return;
    }
    println!(
        "{:<20}  {:<14}  {:<8}  {:<8}  OPERATIONS",
        "NAME", "KIND", "CLI", "ENABLED"
    );
    for item in items {
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
        let cli_ok = item
            .get("cli_available")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let ops: Vec<&str> = item
            .get("operations")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        println!(
            "{:<20}  {:<14}  {:<8}  {:<8}  {}",
            name,
            kind,
            if cli_ok { "yes" } else { "no" },
            if enabled { "yes" } else { "no" },
            ops.join(", ")
        );
    }
}
