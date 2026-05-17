//! `claudette chat hook` — relay a Claude Code hook event to the
//! running GUI.
//!
//! This subcommand is the user-mode endpoint Claude Code's hook
//! configuration shells out to. The hook payload is delivered on stdin
//! as JSON; the GUI ingests it via the `chat_hook` IPC method and
//! routes the event onto the matching interactive session channel.
//!
//! Designed to be invoked from a Claude Code `hooks` entry like:
//!
//! ```text
//! { "type": "command",
//!   "command": "/path/to/claudette chat hook --sid <sid> --kind <kind>" }
//! ```
//!
//! Empty stdin is allowed — the handler decides what to do with an
//! absent payload based on `kind` / `reason`.
//!
//! Exits silently on success (no output) so it doesn't interfere with
//! Claude Code's own output stream.

use std::error::Error;
use std::io::Read;

use clap::Args;

use crate::discovery::AppInfo;
use crate::ipc;

#[derive(Args, Debug)]
pub struct ChatHookArgs {
    /// Interactive session id. Must match the sid the GUI registered
    /// when it spawned the interactive `claude` process.
    #[arg(long)]
    pub sid: String,
    /// Hook kind: `stop`, `awaiting`, `prompt_submitted`, etc. Free
    /// string at the protocol layer — the GUI side validates known
    /// values.
    #[arg(long)]
    pub kind: String,
    /// Optional human-readable reason (e.g. tool name that triggered
    /// the awaiting state). Forwarded verbatim.
    #[arg(long)]
    pub reason: Option<String>,
}

/// Read all of stdin into a single `String`. Empty stdin is OK and
/// produces an empty string.
fn read_stdin_to_string() -> Result<String, std::io::Error> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf)?;
    Ok(buf)
}

pub async fn run(info: &AppInfo, args: ChatHookArgs) -> Result<(), Box<dyn Error>> {
    let payload_stdin = read_stdin_to_string()?;
    let mut params = serde_json::json!({
        "sid": args.sid,
        "kind": args.kind,
        "payload_stdin": payload_stdin,
    });
    if let Some(reason) = args.reason {
        params["reason"] = serde_json::json!(reason);
    }
    // The GUI handler is fire-and-forget; we don't surface its return
    // value on stdout to keep this subcommand silent for the hook
    // pipeline. Errors still propagate (non-zero exit + stderr).
    ipc::call(info, "chat_hook", params).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Mirror the top-level CLI shape just enough to exercise the
    /// argument parser for the new subcommand. The real CLI in
    /// `main.rs` carries other variants we don't need here — keeping a
    /// minimal harness inside the test module avoids leaking the
    /// top-level `Cli` type out of `main.rs` purely for testing.
    #[derive(Parser, Debug)]
    #[command(name = "claudette")]
    struct TestCli {
        #[command(subcommand)]
        command: TestCommand,
    }

    #[derive(clap::Subcommand, Debug)]
    enum TestCommand {
        Chat {
            #[command(subcommand)]
            action: TestChatAction,
        },
    }

    #[derive(clap::Subcommand, Debug)]
    enum TestChatAction {
        Hook(ChatHookArgs),
    }

    #[test]
    fn parses_chat_hook_arguments() {
        let parsed = TestCli::try_parse_from([
            "claudette",
            "chat",
            "hook",
            "--sid",
            "claudette-x-y",
            "--kind",
            "awaiting",
            "--reason",
            "blocked on permission",
        ])
        .unwrap();
        let TestCommand::Chat { action } = parsed.command;
        let TestChatAction::Hook(args) = action;
        assert_eq!(args.sid, "claudette-x-y");
        assert_eq!(args.kind, "awaiting");
        assert_eq!(args.reason.as_deref(), Some("blocked on permission"));
    }

    #[test]
    fn parses_chat_hook_without_reason() {
        let parsed = TestCli::try_parse_from([
            "claudette",
            "chat",
            "hook",
            "--sid",
            "sid-1",
            "--kind",
            "stop",
        ])
        .unwrap();
        let TestCommand::Chat { action } = parsed.command;
        let TestChatAction::Hook(args) = action;
        assert_eq!(args.sid, "sid-1");
        assert_eq!(args.kind, "stop");
        assert!(args.reason.is_none());
    }

    #[test]
    fn chat_hook_requires_sid_and_kind() {
        assert!(
            TestCli::try_parse_from(["claudette", "chat", "hook", "--kind", "stop"]).is_err(),
            "missing --sid must fail"
        );
        assert!(
            TestCli::try_parse_from(["claudette", "chat", "hook", "--sid", "x"]).is_err(),
            "missing --kind must fail"
        );
    }
}
