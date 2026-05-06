//! `claudette repo …` — repository registry subcommands.
//!
//! Today only `list` is wired — the GUI is the registration surface.
//! Future commands (add, remove, show) will land alongside the
//! corresponding IPC handlers.

use std::error::Error;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List registered repositories. Pair with `--json` for scripting.
    List,
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List => {
            let value = ipc::call(&info, "list_repositories", serde_json::json!({})).await?;
            if json {
                output::print_json(&value)?;
            } else {
                render_repo_table(&value);
            }
        }
    }
    Ok(())
}

fn render_repo_table(value: &serde_json::Value) {
    let Some(items) = value.as_array() else {
        eprintln!("(unexpected response shape — try --json)");
        return;
    };
    if items.is_empty() {
        println!("no repositories");
        return;
    }
    println!("{:<36}  {:<24}  PATH", "ID", "NAME");
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("?");
        println!("{id:<36}  {name:<24}  {path}");
    }
}
