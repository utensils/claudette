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

    /// Build an [`AppInfo`] whose `socket` points at the supplied path.
    /// `pid` is set to the current process — `discovery::pid_alive`
    /// isn't consulted by the IPC path; the GUI's socket is the only
    /// thing that matters here.
    fn fake_app_info(socket: &str) -> AppInfo {
        AppInfo {
            pid: std::process::id(),
            socket: socket.to_string(),
            token: "test-token".to_string(),
            app_version: String::new(),
            started_at: String::new(),
        }
    }

    /// Allocate a unique path under the OS temp dir. Uses the current
    /// PID and an atomic counter so parallel tests can't collide.
    fn unique_temp_path(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "claudette-chat-hook-test-{label}-{}-{n}",
            std::process::id()
        ))
    }

    /// Step 1: socket path doesn't exist on disk. The CLI must surface
    /// a `Connect` error (not a panic, not a transport-mid-stream
    /// error) with a user-readable message — the user needs to be
    /// told the GUI socket is gone, not handed a stack trace.
    #[tokio::test]
    async fn chat_hook_fails_clearly_when_socket_missing() {
        let missing = unique_temp_path("missing");
        // Sanity: the path must not exist before we dial it. If a
        // previous test run somehow left a file here, scrub it so the
        // assertion below tests what it claims to.
        let _ = std::fs::remove_file(&missing);
        assert!(
            !missing.exists(),
            "precondition: socket path must not exist"
        );

        let info = fake_app_info(missing.to_str().unwrap());
        let args = ChatHookArgs {
            sid: "sid-test".to_string(),
            kind: "stop".to_string(),
            reason: None,
        };

        let err = run(&info, args)
            .await
            .expect_err("missing socket must error");
        let message = err.to_string();
        // The error should clearly indicate a connection failure —
        // "connect failed: ..." is what `CallError::Connect` renders.
        // We assert on the user-facing string so a future refactor
        // that swallows or reformats this message gets caught.
        assert!(
            message.to_lowercase().contains("connect"),
            "error must mention connect failure, got: {message}"
        );
        // And it must not be empty / placeholder.
        assert!(
            message.len() > 10,
            "error message must be user-readable, got: {message:?}"
        );
    }

    /// Step 2: a regular file exists at the socket path, but nothing
    /// is listening on it (stale socket file). On Unix this is the
    /// "Claudette crashed without unlinking" shape. The CLI must
    /// still report a connect-level error, not silently succeed and
    /// not hang.
    #[tokio::test]
    async fn chat_hook_fails_clearly_on_stale_socket_path() {
        // Create a regular file (not a Unix socket) at the path.
        // `interprocess`'s connect will refuse it on every supported
        // platform — Unix because the inode isn't `SOCK_STREAM`, and
        // Windows because the path doesn't name a live pipe.
        let stale = unique_temp_path("stale");
        std::fs::write(&stale, b"not a socket").expect("setup: write stale placeholder file");

        // Guard the temp file with a drop helper so the test cleans
        // up even if it panics partway through.
        struct Cleanup<'a>(&'a std::path::Path);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0);
            }
        }
        let _cleanup = Cleanup(&stale);

        let info = fake_app_info(stale.to_str().unwrap());
        let args = ChatHookArgs {
            sid: "sid-test".to_string(),
            kind: "stop".to_string(),
            reason: None,
        };

        let err = run(&info, args).await.expect_err("stale socket must error");
        let message = err.to_string();
        assert!(
            message.to_lowercase().contains("connect"),
            "stale-socket error must mention connect failure, got: {message}"
        );
    }
}
