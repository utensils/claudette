use serde::Serialize;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};

use claudette::process::CommandWindowExt as _;

use crate::state::AppState;

/// A line of output emitted while `claude auth login` runs.
#[derive(Clone, Serialize)]
pub struct AuthLoginProgress {
    /// `"stdout"` or `"stderr"` — lets the UI highlight errors differently.
    pub stream: &'static str,
    pub line: String,
}

/// Terminal event emitted when the subprocess exits (cleanly, on error, or killed).
#[derive(Clone, Serialize)]
pub struct AuthLoginComplete {
    pub success: bool,
    /// Non-null when `success` is false.
    pub error: Option<String>,
}

/// Spawn `claude auth login` and stream its output to the frontend.
///
/// The CLI runs its own localhost HTTP listener and opens the user's browser to
/// the OAuth URL; when the browser flow completes it captures the code via the
/// local callback and writes credentials to the keychain. We don't have to pipe
/// any code back through stdin — we just need to wait for the subprocess to exit.
///
/// Events emitted on `app`:
/// - `auth://login-progress` ([`AuthLoginProgress`]) — one per line of stdout/stderr
/// - `auth://login-complete` ([`AuthLoginComplete`]) — fired exactly once when the process ends
///
/// Returns immediately after spawning; the caller should subscribe to the events
/// above to drive UI state. Call [`cancel_claude_auth_login`] to abort.
#[tauri::command]
pub async fn claude_auth_login(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Resolve the binary path before taking the lock — path resolution can do
    // filesystem work, and holding `auth_login_cancel` across that await would
    // stall a concurrent Cancel unnecessarily.
    let claude_path = claudette::agent::resolve_claude_path().await;

    let mut slot = state.auth_login_cancel.lock().await;
    if slot.is_some() {
        return Err("A sign-in flow is already in progress.".into());
    }

    let mut child = Command::new(&claude_path)
        .no_console_window()
        .args(["auth", "login"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            let err = claudette::missing_cli::map_spawn_err(&e, "claude", || {
                format!("Failed to spawn `claude auth login`: {e}")
            });
            crate::missing_cli::handle_err(&app, &err).unwrap_or(err)
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude auth login: missing stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude auth login: missing stderr pipe".to_string())?;

    tokio::spawn(stream_lines(app.clone(), "stdout", stdout));
    tokio::spawn(stream_lines_err(app.clone(), "stderr", stderr));

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    *slot = Some(cancel_tx);
    drop(slot);

    // Separate task owns the child + completion event so the command can return
    // immediately and the UI can render a progress state without blocking IPC.
    // The waiter is the single source of truth for emitting `auth://login-complete`:
    // cancel just signals, the waiter kills and emits.
    let app_exit = app.clone();
    tokio::spawn(async move {
        use tauri::Manager;
        let event = tokio::select! {
            result = child.wait() => status_to_event(result),
            _ = cancel_rx => {
                // Race guard: if the child already exited by the time the cancel
                // signal fired, report the real exit status instead of masking a
                // successful sign-in as a cancellation.
                match child.try_wait() {
                    Ok(Some(status)) => status_to_event(Ok(status)),
                    _ => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        AuthLoginComplete {
                            success: false,
                            error: Some("Sign-in cancelled.".into()),
                        }
                    }
                }
            }
        };
        let _ = app_exit.emit("auth://login-complete", event);
        // Clear the slot so a new flow can start. Harmless if cancel already
        // took the sender — the slot is just set back to None either way.
        let state = app_exit.state::<AppState>();
        *state.auth_login_cancel.lock().await = None;
    });

    Ok(())
}

fn status_to_event(result: std::io::Result<std::process::ExitStatus>) -> AuthLoginComplete {
    match result {
        Ok(status) if status.success() => AuthLoginComplete {
            success: true,
            error: None,
        },
        Ok(status) => AuthLoginComplete {
            success: false,
            error: Some(format!("`claude auth login` exited with {status}")),
        },
        Err(e) => AuthLoginComplete {
            success: false,
            error: Some(format!("Failed to wait on `claude auth login`: {e}")),
        },
    }
}

/// Request cancellation of any in-flight `claude auth login` subprocess.
///
/// Signals the waiter task to kill the subprocess; the waiter then emits
/// `auth://login-complete` with `success: false` exactly once. No-op when
/// no flow is running (does not emit an event in that case).
#[tauri::command]
pub async fn cancel_claude_auth_login(
    _app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut slot = state.auth_login_cancel.lock().await;
    if let Some(tx) = slot.take() {
        // If the receiver was already dropped (waiter finished naturally),
        // the send returns Err — we ignore it since the completion event
        // was already emitted.
        let _ = tx.send(());
    }
    Ok(())
}

async fn stream_lines(app: AppHandle, stream: &'static str, pipe: ChildStdout) {
    let mut reader = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let _ = app.emit("auth://login-progress", AuthLoginProgress { stream, line });
    }
}

async fn stream_lines_err(app: AppHandle, stream: &'static str, pipe: ChildStderr) {
    let mut reader = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let _ = app.emit("auth://login-progress", AuthLoginProgress { stream, line });
    }
}
