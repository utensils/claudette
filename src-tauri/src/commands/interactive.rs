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

use crate::state::{AppState, HookEventKind, InteractiveHookEvent};

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
///
/// `last_screen_blob` carries the most recently captured ANSI screen
/// bytes (or `None` if `interactive_capture_screen` was never called
/// for this sid). Tauri serializes `Vec<u8>` as a JSON number array,
/// matching the `lastScreenBlob: number[] | null` declared by the
/// TypeScript `InteractiveSessionRow`.
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
    pub last_screen_blob: Option<Vec<u8>>,
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
            last_screen_blob: row.last_screen_blob,
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

/// Callback used by [`interactive_start_inner`] to forward CLI-relayed
/// hook events to the frontend. Production wires this to
/// `AppHandle::emit` for `interactive://<sid>/hook`; tests inject a
/// closure that records each emission so the test can assert the
/// channel was wired up.
///
/// Takes the topic + payload separately so the production wrapper can
/// produce the `format!("interactive://{sid}/hook", …)` topic and the
/// test wrapper can record it as-is.
pub(crate) type HookForwardEmitter = Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync + 'static>;

/// Spin up a fresh interactive `claude` session for the given
/// workspace. Persists the resulting row in `interactive_sessions`
/// with state `"running"` and registers the sid in the
/// sid→workspace_id index.
#[tauri::command]
pub async fn interactive_start(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartInteractiveArgs,
) -> Result<StartInteractiveResult, String> {
    let emitter: HookForwardEmitter = {
        let app = app.clone();
        Arc::new(move |topic: &str, payload: &serde_json::Value| {
            let _ = app.emit(topic, payload);
        })
    };
    interactive_start_inner(state.inner(), args, emitter).await
}

/// Testable core of [`interactive_start`]. Identical behavior, but
/// takes a borrowed `AppState` (the same managed instance the
/// production command hands in) plus a callback that emits the
/// `interactive://<sid>/hook` Tauri event payload.
///
/// Splitting this out lets the unit tests in `mod tests` exercise the
/// flag-gate / DB persistence / sid-registration / hook-channel
/// wiring branches without constructing a real `AppHandle` (which
/// requires a full Tauri runtime).
pub(crate) async fn interactive_start_inner(
    state: &AppState,
    args: StartInteractiveArgs,
    emit_hook: HookForwardEmitter,
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

    // Wire the per-session hook channel populated by `claudette-cli chat
    // hook` → IPC `chat_hook` → `dispatch_interactive_hook`. The CLI-side
    // hooks land on this channel; we forward them to the same
    // `interactive://<sid>/hook` Tauri event topic that the attach stream
    // uses so the frontend has a single subscription point regardless of
    // event origin (host-observed vs CLI-relayed).
    let (hook_tx, mut hook_rx) = tokio::sync::mpsc::unbounded_channel::<InteractiveHookEvent>();
    state.register_interactive_hook_channel(&sess.sid, hook_tx);
    let sid_clone = sess.sid.clone();
    tokio::spawn(async move {
        let topic = format!("interactive://{sid_clone}/hook");
        while let Some(ev) = hook_rx.recv().await {
            let payload = serde_json::json!({
                "sid": ev.sid,
                "kind": kind_to_wire(&ev.kind),
                "reason": kind_reason(&ev.kind),
            });
            emit_hook(&topic, &payload);
        }
    });

    Ok(StartInteractiveResult {
        sid: sess.sid,
        host_kind,
    })
}

/// Wire-format `kind` string for an [`InteractiveHookEvent`]. Mirrors
/// the parsing in `ipc.rs::parse_hook_event_kind` so a hook round-trips
/// through CLI → channel → frontend without renaming.
fn kind_to_wire(kind: &HookEventKind) -> &str {
    match kind {
        HookEventKind::Stop => "stop",
        HookEventKind::Awaiting { .. } => "awaiting",
        HookEventKind::PromptSubmitted => "prompt_submitted",
        HookEventKind::SubagentStop => "subagent_stop",
        HookEventKind::Unknown { raw_kind } => raw_kind.as_str(),
    }
}

/// Extract the optional `reason` carried alongside a hook kind. Only
/// `Awaiting` has a reason; every other variant returns `None`.
fn kind_reason(kind: &HookEventKind) -> Option<&str> {
    match kind {
        HookEventKind::Awaiting { reason } => reason.as_deref(),
        _ => None,
    }
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
    interactive_send_input_inner(state.inner(), sid, text).await
}

/// Testable core of [`interactive_send_input`]. See that function for
/// the contract; the only difference is the borrowed `&AppState` so
/// tests can construct a state value directly.
pub(crate) async fn interactive_send_input_inner(
    state: &AppState,
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
    interactive_capture_screen_inner(state.inner(), sid).await
}

/// Testable core of [`interactive_capture_screen`]. See that function
/// for the contract; the only difference is the borrowed `&AppState`
/// so tests can construct a state value directly.
pub(crate) async fn interactive_capture_screen_inner(
    state: &AppState,
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
    let persist_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
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

    // Don't fail the capture command on DB errors — the host already
    // produced the snapshot the caller asked for — but surface the
    // underlying error so a persist regression doesn't go silent.
    match persist_result {
        Ok(()) => {}
        Err(error) => {
            tracing::warn!(
                sid = %sid,
                ?error,
                "capture_screen DB persist failed"
            );
        }
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&ansi_bytes))
}

/// Stop an interactive session. `force=true` maps to
/// [`StopMode::Force`] (SIGKILL on tmux, immediate teardown on the
/// sidecar); otherwise [`StopMode::Graceful`]. The DB row is updated
/// to `state = "stopped"` and the sid→workspace_id mapping is dropped
/// so the frontend's list view reflects the new state on the next
/// refresh.
#[tauri::command]
pub async fn interactive_stop(
    state: State<'_, AppState>,
    sid: String,
    force: bool,
) -> Result<(), String> {
    interactive_stop_inner(state.inner(), sid, force).await
}

/// Testable core of [`interactive_stop`]. See that function for the
/// contract; the only difference is the borrowed `&AppState` so tests
/// can construct a state value directly.
pub(crate) async fn interactive_stop_inner(
    state: &AppState,
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
    let persist_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let db = Database::open(&db_path).map_err(|e| e.to_string())?;
        // See `interactive_capture_screen` for the rationale on
        // string-matching the "no rows" error instead of pattern-
        // matching on `rusqlite::Error`.
        match db.set_interactive_session_state(&sid_for_db, "stopped", None) {
            Ok(()) => Ok(()),
            Err(e) if e.to_string() == "Query returned no rows" => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    // Surface DB-write failures so an interactive_stop that succeeded on
    // the host but failed to persist `state = "stopped"` doesn't go
    // silently — otherwise the row stays `"running"` forever and the
    // sidebar badge / list view never recover.
    if let Err(error) = persist_result {
        tracing::warn!(
            sid = %sid,
            ?error,
            "interactive_stop: DB state write failed; row may stay marked running until next reconcile"
        );
    }
    state.unregister_interactive_session(&sid).await;
    // Drop the sender half of the hook channel so the forwarder task
    // spawned in `interactive_start` exits cleanly. Safe to call for an
    // unknown sid (no-op) per `AppState::unregister_interactive_hook_channel`.
    state.unregister_interactive_hook_channel(&sid);
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
    interactive_list_for_workspace_inner(state.inner(), workspace_id).await
}

/// Testable core of [`interactive_list_for_workspace`]. See that
/// function for the contract; the only difference is the borrowed
/// `&AppState` so tests can construct a state value directly.
pub(crate) async fn interactive_list_for_workspace_inner(
    state: &AppState,
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

/// List the orphaned interactive sids currently pending cleanup.
/// Populated by the boot reconciler when the host reports
/// `claudette-` sessions the DB doesn't know about (see
/// [`crate::interactive_lifecycle`]). The frontend uses this for
/// reload-without-event recovery — the
/// `interactive://orphans-detected` event is fired once at boot, so a
/// page that mounts late can pull the list via this command instead
/// of waiting for the next reboot.
///
/// Returns an empty list when there are no orphans pending; safe to
/// poll without side effects.
#[tauri::command]
pub async fn interactive_list_orphans(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    interactive_list_orphans_inner(state.inner()).await
}

/// Testable core of [`interactive_list_orphans`]. See that function
/// for the contract; the only difference is the borrowed `&AppState`
/// so tests can construct a state value directly.
pub(crate) async fn interactive_list_orphans_inner(
    state: &AppState,
) -> Result<Vec<String>, String> {
    let map = state.interactive_orphans.read().await;
    Ok(map.keys().cloned().collect())
}

/// Stop every orphan interactive session currently registered on
/// [`AppState::interactive_orphans`]. Each call to
/// `host.stop(sid, Graceful)` is best-effort: a failure is logged and
/// skipped so a single unreachable host can't poison the rest of the
/// batch. The DB is untouched (orphans are by definition not in the
/// DB).
///
/// Returns the list of sids that were successfully stopped. Sids that
/// errored out are tracing-logged and dropped from the orphan map so
/// the frontend toast doesn't keep reappearing on repeated calls.
#[tauri::command]
pub async fn interactive_cleanup_orphans(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    interactive_cleanup_orphans_inner(state.inner()).await
}

/// Testable core of [`interactive_cleanup_orphans`]. See that function
/// for the contract; the only difference is the borrowed `&AppState`
/// so tests can construct a state value directly.
pub(crate) async fn interactive_cleanup_orphans_inner(
    state: &AppState,
) -> Result<Vec<String>, String> {
    // Drain the orphan map under a write lock so concurrent cleanup
    // calls don't double-stop the same sid.
    let drained: Vec<(String, Arc<dyn InteractiveHost>)> = {
        let mut map = state.interactive_orphans.write().await;
        map.drain().collect()
    };
    let mut stopped: Vec<String> = Vec::with_capacity(drained.len());
    for (sid, host) in drained {
        match host.stop(&SessionId(sid.clone()), StopMode::Graceful).await {
            Ok(()) => stopped.push(sid),
            Err(err) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    sid = %sid,
                    error = %err,
                    "cleanup_orphans: host.stop failed; dropping from orphan map",
                );
            }
        }
    }
    Ok(stopped)
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
    //! Branch coverage for the `interactive_*` Tauri command handlers.
    //!
    //! Each command is exercised through its `_inner` helper so the
    //! tests can construct a plain `&AppState` (with an on-disk SQLite
    //! file under a tempdir and pre-seeded `interactive_hosts` map)
    //! without booting a real Tauri runtime.
    //!
    //! Test layout (one section per command):
    //!   1. `interactive_start_inner` — happy path + flag-off guard.
    //!   2. `interactive_send_input_inner` — happy path + missing-sid +
    //!      flag-off guard.
    //!   3. `interactive_capture_screen_inner` — happy path (DB persists
    //!      the blob), flag-off, "no rows" tolerance pin.
    //!   4. `interactive_stop_inner` — graceful + force, DB transition
    //!      to `"stopped"`, sid mapping removed.
    //!   5. `interactive_list_for_workspace_inner` — populated + empty.
    //!   6. `interactive_list_orphans_inner` +
    //!      `interactive_cleanup_orphans_inner` — drain + per-sid stop.
    //!
    //! The host-resolution-failure branch for `interactive_start_inner`
    //! is intentionally not exercised: `interactive_host_for` only
    //! returns `Err` when `select_default_host` fails, and the current
    //! `select_default_host` always returns Ok (it falls back to
    //! constructing a `SidecarHost` whose constructor is infallible).
    //! Pre-seeding `interactive_hosts` is the only test path that does
    //! NOT take the failure branch, so we cover that side and leave the
    //! true-failure path uncovered — it is shallow (one `map_err` +
    //! return) and the only failure mode in production is a host that
    //! fails its own connectivity check, which happens later.
    //!
    //! `interactive_attach` is intentionally skipped because the body
    //! is a one-liner that delegates to `spawn_attach_forwarder`, which
    //! consumes a real `AppHandle::emit` directly and would require a
    //! full Tauri runtime to exercise meaningfully.

    use super::*;
    use async_trait::async_trait;
    use claudette::agent::interactive_host::{
        AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
        InteractiveHost, ScreenSnapshot, SessionId,
    };
    use claudette::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
    use claudette::db::{Database, InteractiveSessionRow};
    use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
    use claudette::plugin_runtime::PluginRegistry;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;
    use std::sync::OnceLock;
    use tempfile::TempDir;
    use tokio::sync::Mutex as AsyncMutex;

    /// Process-global async mutex for tests that mutate
    /// `$CLAUDETTE_HOME` or `$CLAUDETTE_CLI`.
    /// `interactive_start_inner` reads both across `await` points
    /// (`claudette::path::claudette_home()` and
    /// `AppState::bundled_cli_binary_path()`), and the env is
    /// process-wide, so two tests poking it at once would race. An
    /// async mutex lets the guard live across the inner-fn `await`
    /// without tripping clippy's `await_holding_lock` lint.
    fn env_lock() -> &'static AsyncMutex<()> {
        static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| AsyncMutex::new(()))
    }

    /// Spin up a fresh on-disk DB under a tempdir, run migrations, and
    /// seed a placeholder repository so per-test workspace inserts
    /// satisfy the FK.
    fn make_db() -> (TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("claudette.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("repo-1", "/tmp/repo1", "repo-1"))
            .unwrap();
        (tmp, db_path)
    }

    fn make_app_state(db_path: PathBuf) -> AppState {
        // Same shape as `tray.rs::fresh_state` /
        // `interactive_lifecycle.rs::tests::make_app_state`. An empty
        // plugin dir keeps registry construction allocation-only.
        let plugins = PluginRegistry::discover(std::path::Path::new("/nonexistent"));
        AppState::new(db_path, std::path::PathBuf::from("/tmp"), plugins)
    }

    fn make_repo(id: &str, path: &str, name: &str) -> Repository {
        Repository {
            id: id.into(),
            path: path.into(),
            name: name.into(),
            path_slug: name.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo_id: &str, name: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: name.into(),
            branch_name: format!("claudette/{name}"),
            worktree_path: None,
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
        }
    }

    fn make_row(sid: &str, ws_id: &str, state: &str) -> InteractiveSessionRow {
        InteractiveSessionRow {
            sid: sid.into(),
            workspace_id: ws_id.into(),
            host_kind: "tmux".into(),
            state: state.into(),
            crash_reason: None,
            created_at: "2026-05-16T00:00:00Z".into(),
            last_attached_at: None,
            last_screen_blob: None,
            claude_flags_json: "[]".into(),
            pid: None,
        }
    }

    /// Recording fake host: every trait method records its parameters
    /// (where useful) and returns canned data. Sessions are tracked as
    /// a `Vec<SessionId>` so `status()` can echo what `ensure_session`
    /// registered.
    struct FakeInteractiveHost {
        ensure_calls: StdMutex<Vec<(SessionId, SessionSpec)>>,
        send_calls: StdMutex<Vec<(SessionId, InputPayload)>>,
        stop_calls: StdMutex<Vec<(SessionId, StopMode)>>,
        capture_calls: StdMutex<Vec<SessionId>>,
        /// Bytes returned from `capture_screen`. Default `\x1b[31mhi\x1b[0m`.
        capture_bytes: Vec<u8>,
        /// Sessions reported by `status()`.
        status_sessions: StdMutex<Vec<HostSessionSummary>>,
    }

    impl FakeInteractiveHost {
        fn new() -> Self {
            Self {
                ensure_calls: StdMutex::new(Vec::new()),
                send_calls: StdMutex::new(Vec::new()),
                stop_calls: StdMutex::new(Vec::new()),
                capture_calls: StdMutex::new(Vec::new()),
                capture_bytes: b"\x1b[31mhi\x1b[0m".to_vec(),
                status_sessions: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl InteractiveHost for FakeInteractiveHost {
        async fn ensure_session(
            &self,
            sid: &SessionId,
            spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            self.ensure_calls
                .lock()
                .unwrap()
                .push((sid.clone(), spec.clone()));
            self.status_sessions
                .lock()
                .unwrap()
                .push(HostSessionSummary {
                    sid: sid.clone(),
                    pid: None,
                    running: true,
                });
            Ok(HostHandle {
                sid: sid.clone(),
                pid: None,
                rows: spec.rows,
                cols: spec.cols,
            })
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unreachable!("D2 tests do not exercise attach")
        }
        async fn send_input(
            &self,
            sid: &SessionId,
            payload: InputPayload,
        ) -> Result<(), HostError> {
            self.send_calls.lock().unwrap().push((sid.clone(), payload));
            Ok(())
        }
        async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            self.capture_calls.lock().unwrap().push(sid.clone());
            Ok(ScreenSnapshot {
                rows: 24,
                cols: 80,
                ansi_bytes: self.capture_bytes.clone(),
            })
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            Ok(())
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            Ok(())
        }
        async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
            self.stop_calls.lock().unwrap().push((sid.clone(), mode));
            Ok(())
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            Ok(HostStatus {
                host_version: "fake".into(),
                sessions: self.status_sessions.lock().unwrap().clone(),
            })
        }
    }

    /// Specialized fake for the orphan-cleanup test. Records every
    /// `stop()` invocation so the test can assert the cleanup batch
    /// reached the expected sids.
    struct StopTrackingHost {
        stop_calls: StdMutex<Vec<(SessionId, StopMode)>>,
    }

    impl StopTrackingHost {
        fn new() -> Self {
            Self {
                stop_calls: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl InteractiveHost for StopTrackingHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unreachable!()
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unreachable!()
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unreachable!()
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unreachable!()
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unreachable!()
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unreachable!()
        }
        async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
            self.stop_calls.lock().unwrap().push((sid.clone(), mode));
            Ok(())
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            Ok(HostStatus {
                host_version: "stop-tracking".into(),
                sessions: vec![],
            })
        }
    }

    fn make_start_args(workspace_id: &str) -> StartInteractiveArgs {
        StartInteractiveArgs {
            workspace_id: workspace_id.into(),
            working_dir: "/tmp/repo1".into(),
            rows: 24,
            cols: 80,
            claude_binary: "claude".into(),
            claude_args: vec!["--print".into()],
        }
    }

    fn null_hook_emitter() -> HookForwardEmitter {
        Arc::new(|_topic: &str, _payload: &serde_json::Value| {})
    }

    // --- Existing pure-function tests ---------------------------------

    #[test]
    fn workspace_short_truncates_to_eight_chars() {
        assert_eq!(workspace_short("0123456789abcdef"), "01234567");
    }

    #[test]
    fn workspace_short_passes_through_shorter_ids() {
        assert_eq!(workspace_short("short"), "short");
        assert_eq!(workspace_short("12345678"), "12345678");
    }

    // --- interactive_start_inner --------------------------------------

    /// Step 1: happy path. With the flag ON, the bundled CLI sidecar
    /// resolvable, and a pre-seeded fake host, `interactive_start_inner`
    /// should:
    ///   - call `ensure_session` on the host exactly once,
    ///   - persist an `interactive_sessions` row in state `"running"`
    ///     with the synthesized sid + workspace_id + claude_args JSON,
    ///   - register the sid in the sid→workspace_id reverse index.
    #[tokio::test]
    async fn interactive_start_happy_path_persists_row_and_registers_sid() {
        let _env_guard = env_lock().lock().await;
        let home_tmp = tempfile::tempdir().unwrap();
        let cli_tmp = tempfile::NamedTempFile::new().unwrap();
        // SAFETY: env mutation is serialized via `env_lock()` so no
        // other thread is reading these vars while we set them.
        unsafe {
            std::env::set_var("CLAUDETTE_HOME", home_tmp.path());
            std::env::set_var("CLAUDETTE_CLI", cli_tmp.path());
        }

        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();

        let state = make_app_state(db_path.clone());
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);

        let result = interactive_start_inner(&state, make_start_args("ws-1"), null_hook_emitter())
            .await
            .expect("happy path must succeed");

        // Host saw exactly one ensure_session call for the synthesized sid.
        // Lock inside a scope so the std MutexGuard drops before any
        // subsequent `.await` (clippy's `await_holding_lock`).
        {
            let ensure_calls = host.ensure_calls.lock().unwrap();
            assert_eq!(
                ensure_calls.len(),
                1,
                "ensure_session must be called exactly once"
            );
            assert_eq!(ensure_calls[0].0.as_str(), result.sid);
            // The spec's claude args + working dir round-trip through the call.
            assert_eq!(ensure_calls[0].1.working_dir, "/tmp/repo1");
            assert_eq!(ensure_calls[0].1.claude_args, vec!["--print".to_string()]);
        }

        // Sid format: `claudette-<workspace-short>-<8 hex chars>`.
        assert!(
            result.sid.starts_with("claudette-ws-1-"),
            "sid should be claudette-<short>-<rand>, got: {}",
            result.sid
        );

        // DB row persisted with the expected shape.
        let row = db.get_interactive_session(&result.sid).unwrap().unwrap();
        assert_eq!(row.workspace_id, "ws-1");
        assert_eq!(row.state, "running");
        assert_eq!(row.claude_flags_json, "[\"--print\"]");
        assert!(row.crash_reason.is_none());

        // sid→workspace_id reverse index populated.
        let reverse = state.interactive_sessions.read().await;
        assert_eq!(
            reverse.get(&result.sid).map(String::as_str),
            Some("ws-1"),
            "reverse index must map the new sid to its workspace",
        );
        drop(reverse);

        // Cleanup env mutations.
        unsafe {
            std::env::remove_var("CLAUDETTE_HOME");
            std::env::remove_var("CLAUDETTE_CLI");
        }
    }

    /// Step 2: flag OFF — even with a pre-seeded host, the command
    /// must short-circuit with `"Claude Interactive is disabled"` and
    /// must NOT call `ensure_session`, register the sid, or touch the
    /// DB.
    #[tokio::test]
    async fn interactive_start_flag_off_returns_disabled_error() {
        let _env_guard = env_lock().lock().await;
        let (_db_tmp, db_path) = make_db();
        // Flag is left unset (defaults to disabled).
        let state = make_app_state(db_path.clone());
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);

        let err = interactive_start_inner(&state, make_start_args("ws-1"), null_hook_emitter())
            .await
            .expect_err("flag-OFF must error");
        assert_eq!(
            err, "Claude Interactive is disabled",
            "flag-OFF must return the canonical disabled string verbatim",
        );

        assert!(
            host.ensure_calls.lock().unwrap().is_empty(),
            "ensure_session must not be called when the flag is off",
        );
        assert!(state.interactive_sessions.read().await.is_empty());
    }

    /// Step 3 deviation: the spec calls for a host-resolution failure
    /// path, but `interactive_host_for` only fails when
    /// `select_default_host` fails, which it never does in practice.
    /// Instead we pin the "missing CLI binary" branch — the closest
    /// reachable failure between host resolution and host-call —
    /// since it is the next exit point and the only failure path that
    /// can be reached without a fault-injection hook into the host
    /// layer.
    #[tokio::test]
    async fn interactive_start_returns_error_when_cli_binary_missing() {
        let _env_guard = env_lock().lock().await;
        let home_tmp = tempfile::tempdir().unwrap();
        // Force `bundled_cli_binary_path` to fail by pointing
        // `CLAUDETTE_CLI` at a guaranteed-nonexistent path that is
        // unique to this test run. This bypasses the
        // current_exe + dev-fallback resolution entirely and pins the
        // missing-CLI error branch on every runner — including CI
        // machines that happen to have a staged sidecar on disk.
        // SAFETY: env mutation serialized via `env_lock()`.
        let bogus_cli = format!(
            "/nonexistent/path/claudette-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        unsafe {
            std::env::set_var("CLAUDETTE_HOME", home_tmp.path());
            std::env::set_var("CLAUDETTE_CLI", &bogus_cli);
        }

        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);

        let err = interactive_start_inner(&state, make_start_args("ws-1"), null_hook_emitter())
            .await
            .expect_err("missing CLI must surface as Err");
        assert_eq!(
            err, "claudette-cli binary not found",
            "missing CLI binary must surface the canonical error string",
        );
        assert!(
            host.ensure_calls.lock().unwrap().is_empty(),
            "ensure_session must not be called when the CLI binary is missing",
        );

        unsafe {
            std::env::remove_var("CLAUDETTE_HOME");
            std::env::remove_var("CLAUDETTE_CLI");
        }
    }

    // --- interactive_send_input_inner ---------------------------------

    /// Step 4 happy path: with the flag ON and a registered sid, the
    /// host receives a `SendInput::Text` payload carrying the exact
    /// bytes passed in.
    #[tokio::test]
    async fn interactive_send_input_forwards_text_to_host() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        let sid = "claudette-ws1-aaaaaaaa";
        state.register_interactive_session(sid, "ws-1".into()).await;

        interactive_send_input_inner(&state, sid.into(), "hello\n".into())
            .await
            .expect("send_input happy path");

        let calls = host.send_calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "exactly one send_input call");
        assert_eq!(calls[0].0.as_str(), sid);
        match &calls[0].1 {
            InputPayload::Text { text } => assert_eq!(text, "hello\n"),
            other => panic!("expected Text payload, got {other:?}"),
        }
    }

    /// Step 4 missing-sid: an unknown sid surfaces a
    /// `"interactive session not found: <sid>"` error (matches the
    /// production format string so the frontend can surface the sid
    /// for diagnostics).
    #[tokio::test]
    async fn interactive_send_input_returns_not_found_for_unknown_sid() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        let state = make_app_state(db_path);

        let err = interactive_send_input_inner(&state, "no-such-sid".into(), "noop".into())
            .await
            .expect_err("missing sid must error");
        assert_eq!(err, "interactive session not found: no-such-sid");
    }

    /// Step 4 flag-OFF: even with a valid registered sid, the command
    /// short-circuits to the disabled error.
    #[tokio::test]
    async fn interactive_send_input_flag_off_returns_disabled_error() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        let sid = "claudette-ws1-bbbbbbbb";
        state.register_interactive_session(sid, "ws-1".into()).await;

        let err = interactive_send_input_inner(&state, sid.into(), "ignored".into())
            .await
            .expect_err("flag-OFF must error");
        assert_eq!(err, "Claude Interactive is disabled");
        assert!(host.send_calls.lock().unwrap().is_empty());
    }

    // --- interactive_capture_screen_inner -----------------------------

    /// Step 5 happy path: capture returns the base64 of the host's
    /// `ansi_bytes`, AND the DB row's `last_screen_blob` is updated
    /// with the same raw bytes.
    #[tokio::test]
    async fn interactive_capture_screen_persists_blob_and_returns_base64() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let sid = "claudette-ws1-cccccccc";
        // Seed the row so `update_interactive_session_screen` finds it.
        db.create_interactive_session(&make_row(sid, "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        state.register_interactive_session(sid, "ws-1".into()).await;

        let b64 = interactive_capture_screen_inner(&state, sid.into())
            .await
            .expect("capture_screen happy path");

        // The base64-encoded payload is the host bytes, base64'd.
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .expect("returned value must be valid base64");
        assert_eq!(decoded.as_slice(), b"\x1b[31mhi\x1b[0m");

        // Same bytes landed in the DB row.
        let row = db.get_interactive_session(sid).unwrap().unwrap();
        assert_eq!(
            row.last_screen_blob.as_deref(),
            Some(b"\x1b[31mhi\x1b[0m".as_slice()),
            "DB persist must mirror the host's ansi_bytes",
        );
        assert!(row.last_attached_at.is_some(), "last_attached_at stamped");
        assert_eq!(host.capture_calls.lock().unwrap().len(), 1);
    }

    /// Step 5 missing-row tolerance: when no DB row exists for the
    /// sid, the underlying CRUD layer returns `QueryReturnedNoRows`,
    /// and the command swallows that specific error so the capture
    /// itself still succeeds. This pins the user-visible contract:
    /// the command does NOT propagate "no rows" as an error.
    #[tokio::test]
    async fn interactive_capture_screen_tolerates_missing_db_row() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        // No interactive_sessions row inserted: the UPDATE will hit
        // zero rows and surface QueryReturnedNoRows, which the command
        // is expected to ignore.
        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        let sid = "claudette-ws1-dddddddd";
        state.register_interactive_session(sid, "ws-1".into()).await;

        let b64 = interactive_capture_screen_inner(&state, sid.into())
            .await
            .expect("missing-row case must still return the base64 blob");
        // Decoding succeeds — the host produced bytes even though
        // persistence was a no-op.
        let _ = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .expect("base64 still valid");
    }

    /// Step 5 flag-OFF: the command short-circuits to the disabled
    /// error without touching the host.
    #[tokio::test]
    async fn interactive_capture_screen_flag_off_returns_disabled_error() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        let sid = "claudette-ws1-eeeeeeee";
        state.register_interactive_session(sid, "ws-1".into()).await;

        let err = interactive_capture_screen_inner(&state, sid.into())
            .await
            .expect_err("flag-OFF must error");
        assert_eq!(err, "Claude Interactive is disabled");
        assert!(host.capture_calls.lock().unwrap().is_empty());
    }

    // --- interactive_stop_inner ---------------------------------------

    /// Step 6 graceful: `force=false` maps to `StopMode::Graceful`,
    /// the DB row transitions to `"stopped"`, AND the sid mapping is
    /// removed.
    #[tokio::test]
    async fn interactive_stop_graceful_marks_row_stopped_and_drops_sid() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let sid = "claudette-ws1-ffffffff";
        db.create_interactive_session(&make_row(sid, "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        state.register_interactive_session(sid, "ws-1".into()).await;

        interactive_stop_inner(&state, sid.into(), false)
            .await
            .expect("graceful stop");

        // Scope the std MutexGuard so it drops before the later `.await`.
        {
            let calls = host.stop_calls.lock().unwrap();
            assert_eq!(calls.len(), 1, "exactly one host.stop call");
            assert!(
                matches!(calls[0].1, StopMode::Graceful),
                "force=false must map to Graceful"
            );
        }

        let row = db.get_interactive_session(sid).unwrap().unwrap();
        assert_eq!(row.state, "stopped", "DB row must move to stopped");
        assert!(
            !state.interactive_sessions.read().await.contains_key(sid),
            "sid→workspace_id mapping must be dropped",
        );
    }

    /// Step 6 force: `force=true` maps to `StopMode::Force`. Same DB
    /// transition and sid-cleanup invariants as the graceful path.
    #[tokio::test]
    async fn interactive_stop_force_uses_force_stop_mode() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let sid = "claudette-ws1-99999999";
        db.create_interactive_session(&make_row(sid, "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        let host = Arc::new(FakeInteractiveHost::new());
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::clone(&host) as _);
        state.register_interactive_session(sid, "ws-1".into()).await;

        interactive_stop_inner(&state, sid.into(), true)
            .await
            .expect("force stop");

        // Scope the std MutexGuard so it drops before the later `.await`.
        {
            let calls = host.stop_calls.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert!(matches!(calls[0].1, StopMode::Force));
        }

        let row = db.get_interactive_session(sid).unwrap().unwrap();
        assert_eq!(row.state, "stopped");
        assert!(!state.interactive_sessions.read().await.contains_key(sid));
    }

    /// Step 6 flag-OFF + missing-sid: cover the early exits.
    #[tokio::test]
    async fn interactive_stop_flag_off_returns_disabled_error() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let err = interactive_stop_inner(&state, "anything".into(), false)
            .await
            .expect_err("flag-OFF must error");
        assert_eq!(err, "Claude Interactive is disabled");
    }

    #[tokio::test]
    async fn interactive_stop_missing_sid_returns_not_found() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        let state = make_app_state(db_path);
        let err = interactive_stop_inner(&state, "no-such-sid".into(), false)
            .await
            .expect_err("missing sid must error");
        assert_eq!(err, "interactive session not found: no-such-sid");
    }

    // --- interactive_list_for_workspace_inner -------------------------

    /// Step 7: a populated workspace returns its rows newest-first,
    /// and the `InteractiveSessionRow` → `InteractiveSessionListItem`
    /// shape conversion preserves every field.
    #[tokio::test]
    async fn interactive_list_for_workspace_returns_rows_for_workspace() {
        let (_db_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        db.insert_workspace(&make_workspace("ws-2", "repo-1", "other"))
            .unwrap();

        // Two rows for ws-1, one for ws-2.
        let mut older = make_row("claudette-ws1-older111", "ws-1", "detached");
        older.created_at = "2026-05-15T00:00:00Z".into();
        let mut newer = make_row("claudette-ws1-newer222", "ws-1", "running");
        newer.created_at = "2026-05-16T00:00:00Z".into();
        let other = make_row("claudette-ws2-only333", "ws-2", "running");
        db.create_interactive_session(&older).unwrap();
        db.create_interactive_session(&newer).unwrap();
        db.create_interactive_session(&other).unwrap();

        let state = make_app_state(db_path);
        let rows = interactive_list_for_workspace_inner(&state, "ws-1".into())
            .await
            .expect("list ws-1");
        assert_eq!(rows.len(), 2, "only ws-1 sessions returned");
        // DESC by created_at: newer first.
        assert_eq!(rows[0].sid, "claudette-ws1-newer222");
        assert_eq!(rows[0].state, "running");
        assert_eq!(rows[1].sid, "claudette-ws1-older111");
        assert_eq!(rows[1].state, "detached");
        for r in &rows {
            assert_eq!(r.workspace_id, "ws-1");
        }
    }

    /// Step 7 empty case: an unknown / empty workspace returns an
    /// empty Vec (not an error).
    #[tokio::test]
    async fn interactive_list_for_workspace_returns_empty_for_unknown_workspace() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let rows = interactive_list_for_workspace_inner(&state, "nonexistent".into())
            .await
            .expect("empty workspace must be Ok([])");
        assert!(rows.is_empty());
    }

    // --- interactive_list_orphans_inner + cleanup_orphans_inner -------

    /// Step 8 list: returns every sid currently in the orphans map.
    #[tokio::test]
    async fn interactive_list_orphans_returns_sids_from_state() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        // Pre-seed two orphan entries.
        let host: Arc<dyn InteractiveHost> = Arc::new(StopTrackingHost::new());
        {
            let mut map = state.interactive_orphans.write().await;
            map.insert("claudette-x-orphan1".to_string(), Arc::clone(&host));
            map.insert("claudette-x-orphan2".to_string(), Arc::clone(&host));
        }

        let mut listed = interactive_list_orphans_inner(&state)
            .await
            .expect("list orphans must be Ok");
        listed.sort();
        assert_eq!(
            listed,
            vec![
                "claudette-x-orphan1".to_string(),
                "claudette-x-orphan2".to_string()
            ],
        );
    }

    /// Step 8 cleanup: drains every orphan, calls `host.stop` once per
    /// sid with `Graceful`, and clears the orphans map.
    #[tokio::test]
    async fn interactive_cleanup_orphans_stops_each_and_drains_map() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let host = Arc::new(StopTrackingHost::new());
        let host_dyn: Arc<dyn InteractiveHost> = Arc::clone(&host) as _;
        {
            let mut map = state.interactive_orphans.write().await;
            map.insert("claudette-x-orphan1".to_string(), Arc::clone(&host_dyn));
            map.insert("claudette-x-orphan2".to_string(), Arc::clone(&host_dyn));
        }

        let mut stopped = interactive_cleanup_orphans_inner(&state)
            .await
            .expect("cleanup must be Ok");
        stopped.sort();
        assert_eq!(
            stopped,
            vec![
                "claudette-x-orphan1".to_string(),
                "claudette-x-orphan2".to_string()
            ],
        );

        // Both stops landed on the host, both with StopMode::Graceful.
        // Scope the std MutexGuard so it drops before the later `.await`.
        {
            let calls = host.stop_calls.lock().unwrap();
            assert_eq!(calls.len(), 2, "one stop per orphan");
            for (_, mode) in calls.iter() {
                assert!(matches!(mode, StopMode::Graceful));
            }
        }

        // Orphans map is fully drained.
        assert!(state.interactive_orphans.read().await.is_empty());
    }

    /// Step 8 cleanup empty: a no-op on an empty map returns an empty
    /// Vec and doesn't error.
    #[tokio::test]
    async fn interactive_cleanup_orphans_empty_map_returns_empty_vec() {
        let (_db_tmp, db_path) = make_db();
        let state = make_app_state(db_path);
        let stopped = interactive_cleanup_orphans_inner(&state)
            .await
            .expect("cleanup on empty map must be Ok");
        assert!(stopped.is_empty());
    }
}
