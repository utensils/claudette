use std::path::Path;

use serde::Serialize;
use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::env::WorkspaceEnv;
use crate::process::CommandWindowExt as _;

use super::AgentSettings;
use super::args::{build_claude_args, build_stdin_message};
use super::binary::resolve_claude_path;
use super::types::{FileAttachment, StreamEvent, parse_stream_line};

/// Events emitted by an agent turn (stream events + process lifecycle).
//
// `Stream` is large (~240 B) and `ProcessExited` is tiny (~8 B), so clippy
// flags the size gap. Boxing `Stream` would force a heap allocation per
// streamed event in the hot path while saving stack only on the rare
// end-of-turn sentinel — a net pessimization. Keep the inline payload.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    /// A parsed stream event from stdout.
    Stream(StreamEvent),
    /// The agent process has exited.
    ProcessExited(Option<i32>),
}

/// Handle for an active agent turn — holds the event receiver and process ID.
pub struct TurnHandle {
    pub event_rx: mpsc::Receiver<AgentEvent>,
    pub pid: u32,
}

/// Run a single agent turn by spawning `claude -p` with the given prompt.
///
/// For the first turn, uses `--session-id` to establish the session.
/// For subsequent turns, uses `--resume` to continue the conversation.
///
/// `allowed_tools` pre-approves tools so they run without interactive
/// permission prompts (e.g. `["Bash", "Read", "Edit"]`).
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    working_dir: &Path,
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
    attachments: &[FileAttachment],
    ws_env: Option<&WorkspaceEnv>,
    resolved_env: Option<&crate::env_provider::ResolvedEnv>,
) -> Result<TurnHandle, String> {
    let has_attachments = !attachments.is_empty();
    let args = build_claude_args(
        session_id,
        prompt,
        is_resume,
        allowed_tools,
        custom_instructions,
        settings,
        has_attachments,
    );

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.no_console_window();
    cmd.args(&args)
        .current_dir(working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", crate::env::enriched_path());

    if has_attachments {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }

    // Strip OAuth tokens inherited from a parent Claude Code session — these
    // use the sk-ant-oat* prefix and are not valid for subprocess API calls.
    // Preserve real API keys (sk-ant-api*) so users who authenticate that way
    // continue to work.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    // Apply user-provided env-provider output (direnv / mise / nix-devshell /
    // dotenv) BEFORE the workspace's CLAUDETTE_* markers so those always win,
    // and BEFORE the settings-driven 1M-context toggle so the UI choice
    // cannot be overridden by a provider that happens to export the same key.
    if let Some(env) = resolved_env {
        env.apply(&mut cmd);
    }
    settings.backend_runtime.apply_to_command(&mut cmd);

    cmd.env_remove("CLAUDE_CODE_DISABLE_1M_CONTEXT");
    if settings.disable_1m_context {
        cmd.env("CLAUDE_CODE_DISABLE_1M_CONTEXT", "1");
    }

    if let Some(ref bridge) = settings.hook_bridge {
        cmd.env(
            crate::agent_mcp::server::ENV_SOCKET_ADDR,
            &bridge.socket_addr,
        );
        cmd.env(crate::agent_mcp::server::ENV_TOKEN, &bridge.token);
    }

    if let Some(env) = ws_env {
        env.apply(&mut cmd);
    }

    let mut child = cmd.spawn().map_err(|e| {
        crate::missing_cli::map_spawn_err(&e, "claude", || {
            format!("Failed to spawn claude at {claude_path:?}: {e}")
        })
    })?;

    let pid = child
        .id()
        .ok_or_else(|| "Process exited immediately".to_string())?;

    // When attachments are present (images, PDFs, or text files), pipe the
    // prompt + content blocks to stdin as a stream-json SDKUserMessage, then
    // close stdin to signal EOF.
    if has_attachments && let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let payload = build_stdin_message(prompt, attachments);
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write attachments payload to stdin: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write stdin newline: {e}"))?;
        // Drop closes the pipe, signalling EOF to the child.
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(128);

    // Stdout reader task — parse stream-json events
    let tx_stdout = event_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match parse_stream_line(&line) {
                Ok(event) => {
                    if tx_stdout.send(AgentEvent::Stream(event)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("Failed to parse stream event: {e}\nLine: {line}");
                }
            }
        }
    });

    // Stderr reader task — log stderr lines
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                eprintln!("[agent stderr] {line}");
            }
        }
    });

    // Process exit watcher — sends ProcessExited when the child terminates
    let tx_exit = event_tx;
    tokio::spawn(async move {
        let status = child.wait().await.ok().and_then(|s| s.code());
        let _ = tx_exit.send(AgentEvent::ProcessExited(status)).await;
    });

    Ok(TurnHandle { event_rx, pid })
}

/// Stop an agent process by killing it.
///
/// Platform-specific: `kill -9 <pid>` on Unix, `taskkill /PID <pid> /T /F`
/// on Windows. The `/T` flag terminates the whole process tree so MCP
/// server children are reaped alongside the parent claude process.
pub async fn stop_agent(pid: u32) -> Result<(), String> {
    let output = stop_agent_force(pid)
        .await
        .map_err(|e| format!("Failed to kill agent: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Platform-specific force-kill invocation. Returns the raw `Output` so
/// callers can shape their own error messages (or ignore exit status
/// when probing liveness, as `stop_agent_graceful` does on Unix).
async fn stop_agent_force(pid: u32) -> std::io::Result<std::process::Output> {
    #[cfg(unix)]
    {
        tokio::process::Command::new("kill")
            .no_console_window()
            .args(["-9", &pid.to_string()])
            .output()
            .await
    }
    #[cfg(windows)]
    {
        tokio::process::Command::new("taskkill")
            .no_console_window()
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
    }
}

/// Gracefully stop an agent process.
///
/// On Unix this is SIGTERM → poll up to 500 ms → SIGKILL. On Windows we
/// issue `taskkill /PID <pid> /T` (no `/F`) first, which sends
/// `WM_CLOSE` / a CTRL_CLOSE_EVENT equivalent and lets the child exit
/// cleanly; if it's still alive after the poll window we escalate to
/// `/F`. Used at idle-session teardown where we don't need an instant
/// kill.
pub async fn stop_agent_graceful(pid: u32) -> Result<(), String> {
    // Send the graceful signal. Errors here are non-fatal — the force
    // escalation below covers any "process didn't respond" case.
    #[cfg(unix)]
    let _ = tokio::process::Command::new("kill")
        .no_console_window()
        .args(["-15", &pid.to_string()])
        .output()
        .await;
    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .no_console_window()
        .args(["/PID", &pid.to_string(), "/T"])
        .output()
        .await;

    // Poll for up to 500 ms. On Unix we use `kill -0` (permission-only
    // probe, no signal sent) which exits non-zero once the pid is gone.
    // On Windows `tasklist /FI "PID eq <pid>"` prints a header line
    // plus one row while the process exists; once the process exits,
    // it prints an "INFO: No tasks..." line to stderr, so we check for
    // the pid in stdout.
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        if !pid_is_alive(pid).await {
            return Ok(());
        }
    }

    // Escalate to force-kill.
    stop_agent(pid).await
}

/// Best-effort liveness probe. Returns `true` if the pid appears to
/// still be running, `false` if the probe indicates it's gone (or if
/// the probe itself fails — a failed probe is treated as "dead" so
/// `stop_agent_graceful` doesn't loop forever on a misbehaving OS).
async fn pid_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let probe = tokio::process::Command::new("kill")
            .no_console_window()
            .args(["-0", &pid.to_string()])
            .output()
            .await;
        probe.is_ok_and(|o| o.status.success())
    }
    #[cfg(windows)]
    {
        let probe = tokio::process::Command::new("tasklist")
            .no_console_window()
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .await;
        match probe {
            Ok(o) if o.status.success() => {
                // /NH suppresses the header; /FO CSV gives one row per
                // match. An alive pid appears in stdout; a dead one
                // yields an "INFO: No tasks..." message on stderr and
                // an empty stdout.
                !String::from_utf8_lossy(&o.stdout).trim().is_empty()
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn test_stop_agent_graceful_stops_process_before_escalation() {
        // Spawn a process that traps SIGTERM and exits cleanly.
        let mut child = tokio::process::Command::new("sh")
            .no_console_window()
            .args(["-c", "trap 'exit 0' TERM; sleep 5"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("failed to spawn test child");

        let pid = child.id().expect("child pid should be available");

        let result = stop_agent_graceful(pid).await;
        assert!(
            result.is_ok(),
            "expected graceful stop to succeed: {result:?}"
        );

        tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
            .await
            .expect("child did not exit in time")
            .expect("failed to reap child");

        // kill -0 should fail for a dead process.
        let probe = tokio::process::Command::new("kill")
            .no_console_window()
            .args(["-0", &pid.to_string()])
            .output()
            .await;
        assert!(
            probe.is_ok_and(|o| !o.status.success()),
            "process {pid} should no longer exist after graceful stop"
        );
    }
}
