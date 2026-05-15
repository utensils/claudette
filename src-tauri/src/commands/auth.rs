use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout, Command};
use tokio::time::timeout;

use claudette::process::{CommandWindowExt as _, sanitize_claude_subprocess_env};

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

#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeAuthState {
    SignedIn,
    SignedOut,
    Unknown,
}

#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub state: ClaudeAuthState,
    pub logged_in: bool,
    pub verified: bool,
    pub auth_method: Option<String>,
    pub api_provider: Option<String>,
    pub message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAuthStatusJson {
    logged_in: bool,
    auth_method: Option<String>,
    api_provider: Option<String>,
}

const AUTH_STATUS_TIMEOUT: Duration = Duration::from_millis(1_500);
const AUTH_VALIDATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Ask the official Claude Code CLI for its local authentication state.
///
/// This intentionally uses `claude auth status --json` instead of the Usage
/// panel's token-reading path. It is a lightweight local probe, bounded by a
/// short timeout so opening Settings never waits on a slow CLI.
///
/// `quiet`: when true, suppresses the missing-CLI dialog event on spawn
/// failure. Used by the startup OAuth-method probe in App.tsx so a user
/// without the Claude CLI installed isn't greeted by a "install claude"
/// dialog at launch — the model picker just stays in its non-OAuth shape.
#[tauri::command]
pub async fn get_claude_auth_status(
    app: AppHandle,
    validate: Option<bool>,
    quiet: Option<bool>,
) -> Result<ClaudeAuthStatus, String> {
    let claude_path = claudette::agent::resolve_claude_path().await;
    let mut command = Command::new(&claude_path);
    command
        .no_console_window()
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PATH", claudette::env::enriched_path());
    sanitize_claude_subprocess_env(&mut command);

    let output = timeout(AUTH_STATUS_TIMEOUT, command.output()).await;

    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            let err = claudette::missing_cli::map_spawn_err(&e, "claude", || {
                format!("Failed to run `claude auth status`: {e}")
            });
            if quiet == Some(true) {
                return Err(err);
            }
            return Err(crate::missing_cli::handle_err(&app, &err).unwrap_or(err));
        }
        Err(_) => {
            let status = ClaudeAuthStatus {
                state: ClaudeAuthState::Unknown,
                logged_in: false,
                verified: false,
                auth_method: None,
                api_provider: None,
                message: Some("Claude Code auth status check timed out.".into()),
            };
            if validate == Some(true) {
                return validate_claude_auth(app, claude_path, status).await;
            }
            return Ok(status);
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let status = if output.status.success() {
        parse_auth_status(&stdout)?
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        auth_status_from_failed_output(&stdout, &stderr)
    };

    if validate == Some(true) {
        return validate_claude_auth(app, claude_path, status).await;
    }

    Ok(status)
}

/// Lightweight, AppHandle-free probe used by the backend resolver to
/// answer "is the local Claude CLI signed in with an OAuth subscription
/// token right now?". Returns `false` on any error path (missing CLI,
/// timeout, parse failure) so the gate fails open — the only caller
/// uses it to block a sensitive route, not to grant one.
//
// `alternative-backends`-gated builds are the only consumer; suppress
// the dead-code warning on stripped builds without forcing the function
// itself behind a feature wall (it's small and stays useful for tests).
#[cfg_attr(not(feature = "alternative-backends"), allow(dead_code))]
pub async fn is_claude_oauth_authenticated() -> bool {
    let claude_path = claudette::agent::resolve_claude_path().await;
    let mut command = Command::new(&claude_path);
    command
        .no_console_window()
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PATH", claudette::env::enriched_path());
    sanitize_claude_subprocess_env(&mut command);

    let Ok(Ok(output)) = timeout(AUTH_STATUS_TIMEOUT, command.output()).await else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(status) = parse_auth_status(&stdout) else {
        return false;
    };
    status.logged_in
        && status
            .auth_method
            .as_deref()
            .is_some_and(|method| method.eq_ignore_ascii_case("oauth_token"))
}

fn parse_auth_status(stdout: &str) -> Result<ClaudeAuthStatus, String> {
    let parsed: ClaudeAuthStatusJson = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse `claude auth status --json` output: {e}"))?;
    Ok(ClaudeAuthStatus {
        state: if parsed.logged_in {
            ClaudeAuthState::SignedIn
        } else {
            ClaudeAuthState::SignedOut
        },
        logged_in: parsed.logged_in,
        verified: false,
        auth_method: parsed.auth_method,
        api_provider: parsed.api_provider,
        message: None,
    })
}

fn auth_status_from_failed_output(stdout: &str, stderr: &str) -> ClaudeAuthStatus {
    if let Ok(status) = parse_auth_status(stdout) {
        return status;
    }

    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("Unable to determine Claude Code authentication status.")
        .to_string();
    let lower = message.to_lowercase();
    let looks_signed_out = lower.contains("not logged")
        || lower.contains("not authenticated")
        || lower.contains("login")
        || lower.contains("credentials");
    ClaudeAuthStatus {
        state: if looks_signed_out {
            ClaudeAuthState::SignedOut
        } else {
            ClaudeAuthState::Unknown
        },
        logged_in: false,
        verified: false,
        auth_method: None,
        api_provider: None,
        message: Some(message),
    }
}

async fn validate_claude_auth(
    app: AppHandle,
    claude_path: std::ffi::OsString,
    local_status: ClaudeAuthStatus,
) -> Result<ClaudeAuthStatus, String> {
    let mut command = Command::new(&claude_path);
    command
        .no_console_window()
        .arg("-p")
        .arg("Reply with exactly: OK")
        .arg("--output-format")
        .arg("json")
        .arg("--no-session-persistence")
        .arg("--disable-slash-commands")
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg(r#"{"mcpServers":{}}"#)
        .arg("--tools")
        .arg("")
        .arg("--model")
        .arg("haiku")
        .arg("--max-budget-usd")
        .arg("0.01")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("PATH", claudette::env::enriched_path());
    sanitize_claude_subprocess_env(&mut command);

    let output = timeout(AUTH_VALIDATE_TIMEOUT, command.output()).await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            let err = claudette::missing_cli::map_spawn_err(&e, "claude", || {
                format!("Failed to run Claude Code auth validation: {e}")
            });
            return Err(crate::missing_cli::handle_err(&app, &err).unwrap_or(err));
        }
        Err(_) => {
            return Ok(ClaudeAuthStatus {
                verified: false,
                message: Some("Claude Code auth validation timed out.".into()),
                state: ClaudeAuthState::Unknown,
                logged_in: local_status.logged_in,
                auth_method: local_status.auth_method,
                api_provider: local_status.api_provider,
            });
        }
    };

    if output.status.success() || validation_reached_authenticated_model(&output.stdout) {
        return Ok(validated_auth_success_status(local_status));
    }

    let message = validation_failure_message(&output.stdout, &output.stderr);
    Ok(ClaudeAuthStatus {
        state: if looks_like_auth_failure(&message) {
            ClaudeAuthState::SignedOut
        } else {
            ClaudeAuthState::Unknown
        },
        logged_in: local_status.logged_in,
        verified: false,
        auth_method: local_status.auth_method,
        api_provider: local_status.api_provider,
        message: Some(message),
    })
}

fn validated_auth_success_status(local_status: ClaudeAuthStatus) -> ClaudeAuthStatus {
    ClaudeAuthStatus {
        state: ClaudeAuthState::SignedIn,
        logged_in: true,
        verified: true,
        message: None,
        ..local_status
    }
}

fn validation_reached_authenticated_model(stdout: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return false;
    };
    value
        .get("subtype")
        .and_then(|subtype| subtype.as_str())
        .is_some_and(|subtype| subtype == "error_max_budget_usd")
}

fn validation_failure_message(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stdout = String::from_utf8_lossy(stdout);
    [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("Claude Code auth validation failed.")
        .to_string()
}

pub(crate) fn looks_like_auth_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("api error: 401")
        || lower.contains("401 invalid authentication credentials")
        || lower.contains("invalid authentication credentials")
        || lower.contains("failed to authenticate")
        || lower.contains("token refresh failed")
        || lower.contains("not logged in")
        || lower.contains("please run /login")
        || lower.contains("run /login")
        || lower.contains("credentials not found")
        || lower.contains("expired or been revoked")
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

    let mut command = Command::new(&claude_path);
    command
        .no_console_window()
        .args(["auth", "login"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", claudette::env::enriched_path())
        .kill_on_drop(true);
    sanitize_claude_subprocess_env(&mut command);

    let mut child = command.spawn().map_err(|e| {
        let err = claudette::missing_cli::map_spawn_err(&e, "claude", || {
            format!("Failed to spawn `claude auth login`: {e}")
        });
        crate::missing_cli::handle_err(&app, &err).unwrap_or(err)
    })?;

    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude auth login: missing stdin pipe".to_string())?;
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
    *state.auth_login_stdin.lock().await = Some(child_stdin);
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
        *state.auth_login_stdin.lock().await = None;
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

/// Submit the one-time browser code requested by `claude auth login`.
#[tauri::command]
pub async fn submit_claude_auth_code(
    code: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("Auth code cannot be empty.".into());
    }

    let mut stdin = {
        let mut slot = state.auth_login_stdin.lock().await;
        slot.take()
            .ok_or_else(|| "No Claude Code sign-in flow is waiting for a code.".to_string())?
    };

    stdin
        .write_all(format!("{code}\n").as_bytes())
        .await
        .map_err(|e| format!("Failed to submit Claude Code auth code: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Claude Code auth code: {e}"))?;

    let cancel_slot = state.auth_login_cancel.lock().await;
    if cancel_slot.is_some() {
        let mut slot = state.auth_login_stdin.lock().await;
        if slot.is_none() {
            *slot = Some(stdin);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logged_in_auth_status() {
        let status = parse_auth_status(
            r#"{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}"#,
        )
        .unwrap();
        assert_eq!(status.state, ClaudeAuthState::SignedIn);
        assert!(status.logged_in);
        assert!(!status.verified);
        assert_eq!(status.auth_method.as_deref(), Some("oauth_token"));
        assert_eq!(status.api_provider.as_deref(), Some("firstParty"));
    }

    #[test]
    fn parses_logged_out_auth_status() {
        let status = parse_auth_status(r#"{"loggedIn":false}"#).unwrap();
        assert_eq!(status.state, ClaudeAuthState::SignedOut);
        assert!(!status.logged_in);
        assert!(!status.verified);
    }

    #[test]
    fn maps_failed_login_output_to_signed_out() {
        let status =
            auth_status_from_failed_output("", "Not authenticated. Run claude auth login.");
        assert_eq!(status.state, ClaudeAuthState::SignedOut);
        assert!(!status.logged_in);
        assert!(!status.verified);
    }

    #[test]
    fn parses_json_status_from_failed_output() {
        let status = auth_status_from_failed_output(
            r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#,
            "",
        );
        assert_eq!(status.state, ClaudeAuthState::SignedOut);
        assert!(!status.logged_in);
        assert_eq!(status.auth_method.as_deref(), Some("none"));
        assert_eq!(status.api_provider.as_deref(), Some("firstParty"));
        assert_eq!(status.message, None);
    }

    #[test]
    fn recognizes_validation_auth_failures() {
        assert!(looks_like_auth_failure(
            "Failed to authenticate. API Error: 401 Invalid authentication credentials",
        ));
        assert!(looks_like_auth_failure("Not logged in · Please run /login"));
        assert!(!looks_like_auth_failure("Model haiku is unavailable"));
    }

    #[test]
    fn validation_budget_error_confirms_auth_reached_model() {
        let stdout = br#"{
            "type":"result",
            "subtype":"error_max_budget_usd",
            "is_error":true,
            "errors":["Reached maximum budget ($0.01)"]
        }"#;

        assert!(validation_reached_authenticated_model(stdout));
        assert!(!validation_reached_authenticated_model(
            br#"{"type":"result","subtype":"error_during_execution"}"#
        ));
        assert!(!validation_reached_authenticated_model(b"Not logged in"));
    }

    #[test]
    fn validation_success_promotes_local_unknown_to_verified_signed_in() {
        let status = validated_auth_success_status(ClaudeAuthStatus {
            state: ClaudeAuthState::Unknown,
            logged_in: false,
            verified: false,
            auth_method: None,
            api_provider: Some("firstParty".to_string()),
            message: Some("Claude Code auth status check timed out.".to_string()),
        });

        assert_eq!(status.state, ClaudeAuthState::SignedIn);
        assert!(status.logged_in);
        assert!(status.verified);
        assert_eq!(status.api_provider.as_deref(), Some("firstParty"));
        assert_eq!(status.message, None);
    }
}
