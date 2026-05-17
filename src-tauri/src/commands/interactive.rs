//! Tauri commands for the Claude (Interactive) experimental backend.
//!
//! These commands surface the [`claudette::agent::claude_interactive`]
//! plumbing built in tasks F1 + F2 to the frontend. They are thin
//! wrappers: they verify the experimental flag, resolve the cached
//! `InteractiveHost` for the workspace, route the call to the host /
//! session helpers, and persist state changes through the
//! `interactive_sessions` table.
//!
//! Routing:
//! - `interactive_start` picks a host via
//!   [`AppState::interactive_host_for`], spawns the session, writes a
//!   matching `interactive_sessions` row, and remembers the
//!   `sid → workspace_id` mapping so per-session calls can find the
//!   host without the frontend passing `workspace_id` every time.
//! - `interactive_send_input` / `interactive_capture_screen` /
//!   `interactive_stop` look the session up by `sid` and forward to
//!   the host's trait methods.
//! - `interactive_attach` runs a Tokio task that subscribes to the
//!   host's `AttachStream` and forwards events as Tauri events
//!   (`interactive://<sid>/output`, `interactive://<sid>/hook`,
//!   `interactive://<sid>/exit`, `interactive://<sid>/error`).
//!
//! All commands return `Result<_, String>` to match the existing
//! Tauri command convention; the underlying typed errors are flattened
//! to their `Display` form so the React side can render them.

use std::sync::Arc;

use base64::Engine as _;
use claudette::agent::claude_interactive::InteractiveSession;
use claudette::agent::interactive_host::{
    AttachEvent, HostError, InteractiveHost, ScreenSnapshot, SessionId,
};
use claudette::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
use claudette::db::{Database, InteractiveSessionRow};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio_stream::StreamExt;

use crate::state::AppState;

/// Arguments for [`interactive_start`]. Mirrors
/// [`SessionSpec`](claudette::agent::interactive_protocol::SessionSpec)
/// closely but omits the `env` and `claude_config_dir` fields — F3 hard-
/// wires an empty env list and lets `InteractiveSession::start`
/// materialize the per-session overlay directory.
#[derive(Debug, Deserialize)]
pub struct StartInteractiveArgs {
    pub workspace_id: String,
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub claude_binary: String,
    pub claude_args: Vec<String>,
}

/// Return shape for [`interactive_start`]. `host_kind` is `"tmux"`
/// when the active host is the tmux-backed implementation and
/// `"sidecar"` otherwise; the frontend uses this string verbatim as
/// the persisted `interactive_sessions.host_kind` value.
#[derive(Debug, Serialize)]
pub struct StartInteractiveResult {
    pub sid: String,
    pub host_kind: String,
}

/// Wire shape for the persisted `interactive_sessions` row returned
/// by [`interactive_list_for_workspace`]. Mirrors
/// [`InteractiveSessionRow`] directly; using a separate frontend type
/// keeps the wire surface stable if the DB row grows columns the
/// frontend doesn't need.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveSessionListItem {
    pub sid: String,
    pub workspace_id: String,
    pub host_kind: String,
    pub state: String,
    pub crash_reason: Option<String>,
    pub created_at: String,
    pub last_attached_at: Option<String>,
    pub claude_flags_json: String,
    pub pid: Option<i64>,
}

impl From<InteractiveSessionRow> for InteractiveSessionListItem {
    fn from(row: InteractiveSessionRow) -> Self {
        Self {
            sid: row.sid,
            workspace_id: row.workspace_id,
            host_kind: row.host_kind,
            state: row.state,
            crash_reason: row.crash_reason,
            created_at: row.created_at,
            last_attached_at: row.last_attached_at,
            claude_flags_json: row.claude_flags_json,
            pid: row.pid,
        }
    }
}

/// Truncate a workspace UUID to its first 8 chars for use as the
/// `<workspace_short>` segment of an interactive session id. Returns
/// the input unchanged when it is already shorter than 8 chars (e.g.
/// test ids), so the resulting `claudette-<short>-<rand>` string
/// stays meaningful in logs.
fn workspace_short(workspace_id: &str) -> &str {
    if workspace_id.len() <= 8 {
        workspace_id
    } else {
        &workspace_id[..8]
    }
}

/// Spin up a fresh interactive `claude` session for the given
/// workspace. Persists the resulting row in `interactive_sessions`
/// with state `"running"` and registers the sid in the
/// sid→workspace_id index.
#[tauri::command]
pub async fn interactive_start(
    state: State<'_, AppState>,
    args: StartInteractiveArgs,
) -> Result<StartInteractiveResult, String> {
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    let host = state
        .interactive_host_for(&args.workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    let overlay_parent = state.runtime_dir_for_interactive().await;
    let cli_bin = state
        .bundled_cli_binary_path()
        .await
        .ok_or_else(|| "claudette-cli binary not found".to_string())?;
    let host_kind = state
        .interactive_host_kind_for(&args.workspace_id)
        .await
        .to_string();
    let claude_args_json = serde_json::to_string(&args.claude_args).map_err(|e| e.to_string())?;
    let workspace_id = args.workspace_id.clone();
    let spec = SessionSpec {
        working_dir: args.working_dir,
        rows: args.rows,
        cols: args.cols,
        claude_binary: args.claude_binary,
        claude_args: args.claude_args,
        env: vec![],
        claude_config_dir: String::new(),
    };
    let sess = InteractiveSession::start(
        workspace_short(&workspace_id),
        host,
        spec,
        &overlay_parent,
        &cli_bin,
    )
    .await
    .map_err(|e| e.to_string())?;

    let row = InteractiveSessionRow {
        sid: sess.sid.clone(),
        workspace_id: workspace_id.clone(),
        host_kind: host_kind.clone(),
        state: "running".into(),
        crash_reason: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_attached_at: None,
        last_screen_blob: None,
        claude_flags_json: claude_args_json,
        pid: None,
    };
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
        db.create_interactive_session(&row)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    state
        .register_interactive_session(&sess.sid, workspace_id)
        .await;
    Ok(StartInteractiveResult {
        sid: sess.sid,
        host_kind,
    })
}

/// Forward a UTF-8 text payload to the interactive session as a
/// `SendInput { kind: text }` request. The host implementations
/// translate this to either a tmux `send-keys` call (Unix) or an
/// `InputPayload::Text` envelope over the sidecar socket.
#[tauri::command]
pub async fn interactive_send_input(
    state: State<'_, AppState>,
    sid: String,
    text: String,
) -> Result<(), String> {
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    let host = state
        .host_for_session(&sid)
        .await
        .ok_or_else(|| format!("interactive session not found: {sid}"))?;
    host.send_input(&SessionId(sid), InputPayload::Text { text })
        .await
        .map_err(|e| e.to_string())
}

/// Capture the current ANSI screen contents for an interactive
/// session. Returns the bytes base64-encoded so the frontend can
/// pipe them through a text-based transport; the same bytes are
/// persisted via [`Database::update_interactive_session_screen`] so
/// a reattach can repaint instantly.
#[tauri::command]
pub async fn interactive_capture_screen(
    state: State<'_, AppState>,
    sid: String,
) -> Result<String, String> {
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    let host = state
        .host_for_session(&sid)
        .await
        .ok_or_else(|| format!("interactive session not found: {sid}"))?;
    let ScreenSnapshot { ansi_bytes, .. } = host
        .capture_screen(&SessionId(sid.clone()))
        .await
        .map_err(|e| e.to_string())?;

    let db_path = state.db_path.clone();
    let blob = ansi_bytes.clone();
    let sid_for_db = sid.clone();
    let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
        // Persistence is best-effort: a missing row (session was
        // already torn down) shouldn't fail the capture command.
        // The CRUD layer returns `QueryReturnedNoRows` in that case;
        // we recognize it by `Display`-equality so this file doesn't
        // need a direct `rusqlite` dep (lib re-exports `Database` but
        // not the error type).
        match db.update_interactive_session_screen(&sid_for_db, &blob) {
            Ok(()) => Ok(()),
            Err(e) if e.to_string() == "Query returned no rows" => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&ansi_bytes))
}

/// Stop an interactive session. `force=true` maps to
/// [`StopMode::Force`] (SIGKILL on tmux, immediate teardown on the
/// sidecar); otherwise [`StopMode::Graceful`]. The DB row is updated
/// to `state = "exited"` and the sid→workspace_id mapping is dropped
/// so the frontend's list view reflects the new state on the next
/// refresh.
#[tauri::command]
pub async fn interactive_stop(
    state: State<'_, AppState>,
    sid: String,
    force: bool,
) -> Result<(), String> {
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    let host = state
        .host_for_session(&sid)
        .await
        .ok_or_else(|| format!("interactive session not found: {sid}"))?;
    let mode = if force {
        StopMode::Force
    } else {
        StopMode::Graceful
    };
    let stop_result = host.stop(&SessionId(sid.clone()), mode).await;

    // Update DB + drop sid mapping regardless of stop_result so a
    // partial failure doesn't leave a stale "running" row behind.
    let db_path = state.db_path.clone();
    let sid_for_db = sid.clone();
    let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
        // See `interactive_capture_screen` for the rationale on
        // string-matching the "no rows" error instead of pattern-
        // matching on `rusqlite::Error`.
        match db.set_interactive_session_state(&sid_for_db, "exited", None) {
            Ok(()) => Ok(()),
            Err(e) if e.to_string() == "Query returned no rows" => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    state.unregister_interactive_session(&sid).await;
    stop_result.map_err(|e| e.to_string())
}

/// List every persisted interactive session for `workspace_id`. The
/// underlying CRUD already orders by `created_at DESC` so the
/// returned list is newest-first.
#[tauri::command]
pub async fn interactive_list_for_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<InteractiveSessionListItem>, String> {
    let db_path = state.db_path.clone();
    let rows =
        tokio::task::spawn_blocking(move || -> Result<Vec<InteractiveSessionRow>, String> {
            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
            db.list_interactive_sessions_for_workspace(&workspace_id)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Wire payload for `interactive://<sid>/output`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    sid: String,
    seq: u64,
    bytes_b64: String,
}

/// Wire payload for `interactive://<sid>/exit`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    sid: String,
    exit_status: i32,
    reason: String,
}

/// Wire payload for `interactive://<sid>/error`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamErrorPayload {
    sid: String,
    message: String,
    recoverable: bool,
}

/// Wire payload for `interactive://<sid>/hook`. The inner `hook`
/// shape is the existing `HookFired` enum from the interactive
/// protocol crate, which already derives `Serialize`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookPayload {
    sid: String,
    hook: claudette::agent::interactive_protocol::HookFired,
}

/// Subscribe to the live attach stream for an interactive session
/// and forward events to the frontend as Tauri events. Returns
/// immediately after spawning the forwarding task; the task ends
/// when the host's `AttachStream` terminates (session exit, host
/// disconnect, or detach).
///
/// Events emitted, all keyed by `sid`:
/// - `interactive://<sid>/output` — chunked ANSI bytes (base64).
/// - `interactive://<sid>/hook` — Claude Code lifecycle hook fired
///   inside the session.
/// - `interactive://<sid>/exit` — host signaled the session exited.
/// - `interactive://<sid>/error` — recoverable / fatal stream
///   error from the host.
#[tauri::command]
pub async fn interactive_attach(
    app: AppHandle,
    state: State<'_, AppState>,
    sid: String,
) -> Result<(), String> {
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    let host = state
        .host_for_session(&sid)
        .await
        .ok_or_else(|| format!("interactive session not found: {sid}"))?;
    spawn_attach_forwarder(app, host, sid).await
}

/// Helper extracted so the spawned task can be unit-tested as a
/// pure function over an arbitrary `InteractiveHost`. The attach
/// call itself is awaited synchronously so any wire error (e.g.
/// host refused) surfaces to the frontend instead of disappearing
/// into a background task.
async fn spawn_attach_forwarder(
    app: AppHandle,
    host: Arc<dyn InteractiveHost>,
    sid: String,
) -> Result<(), String> {
    let session_id = SessionId(sid.clone());
    let (_attach_id, mut stream) = host
        .attach(&session_id)
        .await
        .map_err(|e: HostError| e.to_string())?;
    let output_topic = format!("interactive://{sid}/output");
    let hook_topic = format!("interactive://{sid}/hook");
    let exit_topic = format!("interactive://{sid}/exit");
    let error_topic = format!("interactive://{sid}/error");
    tokio::spawn(async move {
        while let Some(ev) = stream.next().await {
            match ev {
                AttachEvent::Output { bytes, seq } => {
                    let payload = OutputPayload {
                        sid: sid.clone(),
                        seq,
                        bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    };
                    let _ = app.emit(&output_topic, &payload);
                }
                AttachEvent::Hook(hook) => {
                    let payload = HookPayload {
                        sid: sid.clone(),
                        hook,
                    };
                    let _ = app.emit(&hook_topic, &payload);
                }
                AttachEvent::Exit {
                    exit_status,
                    reason,
                } => {
                    let payload = ExitPayload {
                        sid: sid.clone(),
                        exit_status,
                        reason,
                    };
                    let _ = app.emit(&exit_topic, &payload);
                }
                AttachEvent::Error {
                    message,
                    recoverable,
                } => {
                    let payload = StreamErrorPayload {
                        sid: sid.clone(),
                        message,
                        recoverable,
                    };
                    let _ = app.emit(&error_topic, &payload);
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_short_truncates_to_eight_chars() {
        assert_eq!(workspace_short("0123456789abcdef"), "01234567");
    }

    #[test]
    fn workspace_short_passes_through_shorter_ids() {
        assert_eq!(workspace_short("short"), "short");
        assert_eq!(workspace_short("12345678"), "12345678");
    }
}
