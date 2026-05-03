//! `claudette chat …` — chat session subcommands.
//!
//! `chat send` is the primary command for the batch-fan-out use case:
//! `claudette workspace create` returns a `default_session_id`, which
//! `chat send` then targets to dispatch the initial prompt. The agent
//! runs inside the GUI process, so its output appears in the GUI's
//! workspace tab; the CLI exits as soon as the message is enqueued.

use std::error::Error;
use std::path::PathBuf;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List chat sessions for a workspace.
    List {
        /// Workspace ID. Get one from `claudette workspace list`.
        workspace: String,
        /// Include archived sessions in the output.
        #[arg(long)]
        include_archived: bool,
    },
    /// Send a message to a chat session, kicking off an agent turn.
    Send {
        /// Chat session ID. Newly-created workspaces have a default
        /// session id returned in their `create_workspace` response.
        session: String,
        /// Message body. Use `@path/to/file.md` to read the prompt
        /// from a file (the most common form for batch-driven prompts).
        /// Use `-` to read from stdin.
        prompt: String,
        /// Override the model for this turn (e.g. `opus`, `sonnet`).
        #[arg(long)]
        model: Option<String>,
        /// Run the agent in plan mode (read-only, must approve plan
        /// before any tool use).
        #[arg(long)]
        plan: bool,
        /// Override the permission level (`default`, `acceptEdits`,
        /// `bypassPermissions`).
        #[arg(long)]
        permission: Option<String>,
    },
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List {
            workspace,
            include_archived,
        } => {
            let value = ipc::call(
                &info,
                "list_chat_sessions",
                serde_json::json!({
                    "workspace_id": workspace,
                    "include_archived": include_archived,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Send {
            session,
            prompt,
            model,
            plan,
            permission,
        } => {
            let content = resolve_prompt(&prompt)?;
            let mut params = serde_json::json!({
                "session_id": session,
                "content": content,
            });
            if let Some(m) = model {
                params["model"] = serde_json::json!(m);
            }
            if plan {
                params["plan_mode"] = serde_json::json!(true);
            }
            if let Some(p) = permission {
                params["permission_level"] = serde_json::json!(p);
            }
            let value = ipc::call(&info, "send_chat_message", params).await?;
            if json {
                output::print_json(&value)?;
            } else {
                println!("ok");
            }
        }
    }
    Ok(())
}

/// Resolve the prompt argument:
/// - `@path` reads from the named file (most common for batch use)
/// - `-` reads from stdin (pipe-friendly)
/// - anything else is used verbatim
fn resolve_prompt(arg: &str) -> Result<String, Box<dyn Error>> {
    if arg == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)?;
        return Ok(buf);
    }
    if let Some(path) = arg.strip_prefix('@') {
        let path = PathBuf::from(path);
        let bytes = std::fs::read(&path)
            .map_err(|e| format!("read prompt file {}: {e}", path.display()))?;
        return Ok(
            String::from_utf8(bytes).map_err(|e| format!("prompt file is not valid UTF-8: {e}"))?
        );
    }
    Ok(arg.to_string())
}
