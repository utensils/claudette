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
    /// Show a session snapshot: session metadata, recent messages, tool turns, attachments, pending controls.
    Show {
        /// Chat session ID.
        session: String,
        /// Maximum number of recent messages to include.
        #[arg(long)]
        limit: Option<i64>,
        /// Page backward before this message ID.
        #[arg(long)]
        before: Option<String>,
    },
    /// Show persisted completed turns and tool activity for a session.
    Turns {
        /// Chat session ID.
        session: String,
    },
    /// Show attachment metadata for a session.
    Attachments {
        /// Chat session ID.
        session: String,
    },
    /// Fetch a full attachment body as base64.
    AttachmentData {
        /// Attachment ID.
        attachment: String,
    },
    /// Create a chat session in a workspace.
    Create {
        /// Workspace ID.
        workspace: String,
    },
    /// Rename a chat session.
    Rename {
        /// Chat session ID.
        session: String,
        /// New session name.
        name: String,
    },
    /// Archive a chat session.
    Archive {
        /// Chat session ID.
        session: String,
    },
    /// Stop a running agent turn.
    Stop {
        /// Chat session ID.
        session: String,
    },
    /// Reset the underlying Claude resume state for a session.
    Reset {
        /// Chat session ID.
        session: String,
    },
    /// Clear the attention flag for a session.
    ClearAttention {
        /// Chat session ID.
        session: String,
    },
    /// Answer a pending AskUserQuestion control request.
    Answer {
        /// Chat session ID.
        session: String,
        /// Pending tool_use_id.
        tool_use_id: String,
        /// JSON object keyed by question text.
        #[arg(long)]
        answers_json: String,
    },
    /// Approve a pending ExitPlanMode request.
    ApprovePlan {
        /// Chat session ID.
        session: String,
        /// Pending tool_use_id.
        tool_use_id: String,
    },
    /// Deny a pending ExitPlanMode request with feedback.
    DenyPlan {
        /// Chat session ID.
        session: String,
        /// Pending tool_use_id.
        tool_use_id: String,
        /// Feedback to send to the agent.
        reason: String,
    },
    /// Steer the currently running queued turn with another user message.
    Steer {
        /// Chat session ID.
        session: String,
        /// Message body. Supports literal text, @file, or - for stdin.
        prompt: String,
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
        Action::Show {
            session,
            limit,
            before,
        } => {
            let value = ipc::call(
                &info,
                "get_chat_snapshot",
                build_show_params(&session, limit, before),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Turns { session } => {
            let value = ipc::call(
                &info,
                "load_completed_turns",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Attachments { session } => {
            let value = ipc::call(
                &info,
                "load_attachments_for_session",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::AttachmentData { attachment } => {
            let value = ipc::call(
                &info,
                "load_attachment_data",
                serde_json::json!({ "attachment_id": attachment }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Create { workspace } => {
            let value = ipc::call(
                &info,
                "create_chat_session",
                serde_json::json!({ "workspace_id": workspace }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Rename { session, name } => {
            let value = ipc::call(
                &info,
                "rename_chat_session",
                serde_json::json!({ "session_id": session, "name": name }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Archive { session } => {
            let value = ipc::call(
                &info,
                "archive_chat_session",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Stop { session } => {
            let value = ipc::call(
                &info,
                "stop_agent",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Reset { session } => {
            let value = ipc::call(
                &info,
                "reset_agent_session",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::ClearAttention { session } => {
            let value = ipc::call(
                &info,
                "clear_attention",
                serde_json::json!({ "session_id": session }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Answer {
            session,
            tool_use_id,
            answers_json,
        } => {
            let value = ipc::call(
                &info,
                "submit_agent_answer",
                build_answer_params(&session, &tool_use_id, &answers_json)?,
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::ApprovePlan {
            session,
            tool_use_id,
        } => {
            let value = ipc::call(
                &info,
                "submit_plan_approval",
                serde_json::json!({
                    "session_id": session,
                    "tool_use_id": tool_use_id,
                    "approved": true,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::DenyPlan {
            session,
            tool_use_id,
            reason,
        } => {
            let value = ipc::call(
                &info,
                "submit_plan_approval",
                serde_json::json!({
                    "session_id": session,
                    "tool_use_id": tool_use_id,
                    "approved": false,
                    "reason": reason,
                }),
            )
            .await?;
            output::print_json(&value)?;
        }
        Action::Steer { session, prompt } => {
            let content = resolve_prompt(&prompt)?;
            let value = ipc::call(
                &info,
                "steer_queued_chat_message",
                serde_json::json!({
                    "session_id": session,
                    "content": content,
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
            let params = build_send_params(SendParamInput {
                session: &session,
                content,
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
            });
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

struct SendParamInput<'a> {
    session: &'a str,
    content: String,
    model: Option<String>,
    plan: bool,
    no_plan: bool,
    thinking: bool,
    no_thinking: bool,
    fast: bool,
    no_fast: bool,
    effort: Option<String>,
    chrome: bool,
    no_chrome: bool,
    disable_1m_context: bool,
    no_disable_1m_context: bool,
    permission: Option<String>,
}

fn build_show_params(
    session: &str,
    limit: Option<i64>,
    before: Option<String>,
) -> serde_json::Value {
    let mut params = serde_json::json!({ "session_id": session });
    if let Some(limit) = limit {
        params["limit"] = serde_json::json!(limit);
    }
    if let Some(before) = before {
        params["before_message_id"] = serde_json::json!(before);
    }
    params
}

fn build_answer_params(
    session: &str,
    tool_use_id: &str,
    answers_json: &str,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let answers: serde_json::Value = serde_json::from_str(answers_json)
        .map_err(|e| format!("answers-json must be a JSON object: {e}"))?;
    if !answers.is_object() {
        return Err("answers-json must be a JSON object".into());
    }
    Ok(serde_json::json!({
        "session_id": session,
        "tool_use_id": tool_use_id,
        "answers": answers,
    }))
}

fn build_send_params(input: SendParamInput<'_>) -> serde_json::Value {
    let mut params = serde_json::json!({
        "session_id": input.session,
        "content": input.content,
    });
    if let Some(m) = input.model {
        params["model"] = serde_json::json!(m);
    }
    // Tri-state booleans. `--plan` → Some(true), `--no-plan` →
    // Some(false), neither → None (omitted from the params object).
    let resolve = |yes: bool, no: bool| -> Option<bool> {
        if yes {
            Some(true)
        } else if no {
            Some(false)
        } else {
            None
        }
    };
    if let Some(v) = resolve(input.plan, input.no_plan) {
        params["plan_mode"] = serde_json::json!(v);
    }
    if let Some(v) = resolve(input.thinking, input.no_thinking) {
        params["thinking_enabled"] = serde_json::json!(v);
    }
    if let Some(v) = resolve(input.fast, input.no_fast) {
        params["fast_mode"] = serde_json::json!(v);
    }
    if let Some(e) = input.effort {
        params["effort"] = serde_json::json!(e);
    }
    if let Some(v) = resolve(input.chrome, input.no_chrome) {
        params["chrome_enabled"] = serde_json::json!(v);
    }
    if let Some(v) = resolve(input.disable_1m_context, input.no_disable_1m_context) {
        params["disable_1m_context"] = serde_json::json!(v);
    }
    if let Some(p) = input.permission {
        params["permission_level"] = serde_json::json!(p);
    }
    params
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn build_show_params_threads_limit_and_cursor() {
        let params = build_show_params("s1", Some(25), Some("m10".into()));
        assert_eq!(params["session_id"], "s1");
        assert_eq!(params["limit"], 25);
        assert_eq!(params["before_message_id"], "m10");
    }

    #[test]
    fn build_answer_params_requires_json_object() {
        let ok = build_answer_params("s1", "toolu_1", r#"{"Question?":"Answer"}"#).unwrap();
        assert_eq!(ok["answers"]["Question?"], "Answer");
        assert!(build_answer_params("s1", "toolu_1", "[]").is_err());
        assert!(build_answer_params("s1", "toolu_1", "not json").is_err());
    }

    #[test]
    fn resolve_prompt_reads_literal_and_file() {
        let path = std::env::temp_dir().join(format!(
            "claudette-cli-chat-test-{}-prompt.md",
            std::process::id()
        ));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"from file").unwrap();

        assert_eq!(resolve_prompt("literal").unwrap(), "literal");
        assert_eq!(
            resolve_prompt(&format!("@{}", path.display())).unwrap(),
            "from file"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn build_send_params_keeps_tri_state_flags() {
        let params = build_send_params(SendParamInput {
            session: "s1",
            content: "hello".into(),
            model: Some("sonnet".into()),
            plan: true,
            no_plan: false,
            thinking: false,
            no_thinking: true,
            fast: false,
            no_fast: false,
            effort: Some("high".into()),
            chrome: true,
            no_chrome: false,
            disable_1m_context: false,
            no_disable_1m_context: false,
            permission: Some("standard".into()),
        });
        assert_eq!(params["session_id"], "s1");
        assert_eq!(params["content"], "hello");
        assert_eq!(params["model"], "sonnet");
        assert_eq!(params["plan_mode"], true);
        assert_eq!(params["thinking_enabled"], false);
        assert!(params.get("fast_mode").is_none());
        assert_eq!(params["effort"], "high");
        assert_eq!(params["chrome_enabled"], true);
        assert_eq!(params["permission_level"], "standard");
    }
}
