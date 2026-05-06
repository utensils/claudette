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
    /// Mirrors every lever the GUI's chat input bar exposes. Boolean
    /// flag pairs (`--plan` / `--no-plan`, etc.) default to `false`
    /// when omitted — pass the flag explicitly to enable it.
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
        /// before any tool use). Pair: `--no-plan` forces off, useful
        /// when the workspace's GUI default is on.
        #[arg(long, overrides_with = "no_plan")]
        plan: bool,
        #[arg(long = "no-plan", overrides_with = "plan", hide = true)]
        no_plan: bool,
        /// Enable extended thinking for this turn. Pair: `--no-thinking`
        /// forces off.
        #[arg(long, overrides_with = "no_thinking")]
        thinking: bool,
        #[arg(long = "no-thinking", overrides_with = "thinking", hide = true)]
        no_thinking: bool,
        /// Enable fast mode (lower-latency model variant when supported).
        /// Pair: `--no-fast` forces off.
        #[arg(long, overrides_with = "no_fast")]
        fast: bool,
        #[arg(long = "no-fast", overrides_with = "fast", hide = true)]
        no_fast: bool,
        /// Effort level: `low`, `medium`, `high`, `xhigh`, `max`
        /// (`max` requires Opus 4.6).
        #[arg(long)]
        effort: Option<String>,
        /// Enable Chrome browser mode for this session. Pair: `--no-chrome`
        /// forces off.
        #[arg(long, overrides_with = "no_chrome")]
        chrome: bool,
        #[arg(long = "no-chrome", overrides_with = "chrome", hide = true)]
        no_chrome: bool,
        /// Suppress the Max-plan auto-upgrade to a 1M context window
        /// for the spawned CLI process. Pair: `--no-disable-1m-context`
        /// forces the upgrade on for this turn.
        #[arg(long = "disable-1m-context", overrides_with = "no_disable_1m_context")]
        disable_1m_context: bool,
        #[arg(
            long = "no-disable-1m-context",
            overrides_with = "disable_1m_context",
            hide = true
        )]
        no_disable_1m_context: bool,
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
            no_plan,
            thinking,
            no_thinking,
            fast,
            no_fast,
            effort,
            chrome,
            no_chrome,
            disable_1m_context,
            no_disable_1m_context,
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
            // Tri-state booleans. `--plan` → Some(true), `--no-plan` →
            // Some(false), neither → None (omitted from the params
            // object). The backend currently substitutes `false` for
            // any omitted boolean, so for now Some(false) and None
            // produce the same agent behavior — the tri-state lives in
            // the wire shape so a future backend change to honour
            // workspace defaults on omission won't need a CLI bump.
            let resolve = |yes: bool, no: bool| -> Option<bool> {
                if yes {
                    Some(true)
                } else if no {
                    Some(false)
                } else {
                    None
                }
            };
            if let Some(v) = resolve(plan, no_plan) {
                params["plan_mode"] = serde_json::json!(v);
            }
            if let Some(v) = resolve(thinking, no_thinking) {
                params["thinking_enabled"] = serde_json::json!(v);
            }
            if let Some(v) = resolve(fast, no_fast) {
                params["fast_mode"] = serde_json::json!(v);
            }
            if let Some(e) = effort {
                params["effort"] = serde_json::json!(e);
            }
            if let Some(v) = resolve(chrome, no_chrome) {
                params["chrome_enabled"] = serde_json::json!(v);
            }
            if let Some(v) = resolve(disable_1m_context, no_disable_1m_context) {
                params["disable_1m_context"] = serde_json::json!(v);
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
