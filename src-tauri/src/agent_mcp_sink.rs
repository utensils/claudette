//! Tauri-side glue for the agent MCP bridge.
//!
//! The bridge in `claudette::agent_mcp` is Tauri-free so it can be unit-tested
//! against a mock sink. This module bridges its [`Sink`] trait to:
//!   - SQLite: persists the file as an `Attachment` row with `origin = 'agent'`.
//!   - Tauri events: emits `agent-attachment-created` so the frontend can
//!     re-render the relevant message inline.
//!
//! Anchor-message strategy (v1): the attachment is filed against the *user
//! message that triggered the in-flight turn*. The id is stashed on
//! `AgentSessionState.last_user_msg_id` at turn start. This keeps the FK
//! cascade clean (user/assistant turn-pair gets deleted together) without
//! needing to pre-create an empty assistant message.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use base64::Engine;
use claudette::agent_mcp::bridge::Sink;
use claudette::agent_mcp::protocol::{BridgePayload, BridgeResponse};
use claudette::agent_mcp::tools::send_to_user::policy;
use claudette::db::Database;
use claudette::model::{Attachment, AttachmentOrigin};
use claudette::scheduling::ScheduleTarget;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Tauri-side implementation of [`Sink`] — one per persistent agent session.
///
/// `chat_session_id` is the key used to look up the agent's `AgentSessionState`
/// in `AppState.agents` (and therefore the `last_user_msg_id` anchor) and the
/// key the frontend listener uses to merge the new attachment into the right
/// `chatAttachments[sessionId]` slice. `workspace_id` is still emitted on the
/// event for any host-side filtering (e.g. notifications) that wants
/// workspace granularity, but the chat-surface routing path no longer reads
/// it. Both are kept on the struct because they are NOT the same id.
pub struct ChatBridgeSink {
    pub app: AppHandle,
    pub db_path: PathBuf,
    pub workspace_id: String,
    pub chat_session_id: String,
}

impl Sink for ChatBridgeSink {
    fn handle(
        &self,
        payload: BridgePayload,
    ) -> Pin<Box<dyn Future<Output = BridgeResponse> + Send + '_>> {
        let app = self.app.clone();
        let db_path = self.db_path.clone();
        let workspace_id = self.workspace_id.clone();
        let chat_session_id = self.chat_session_id.clone();
        Box::pin(async move {
            handle_payload(app, db_path, workspace_id, chat_session_id, payload).await
        })
    }
}

#[derive(Serialize, Clone)]
struct AgentAttachmentEvent {
    workspace_id: String,
    /// The chat session the attachment belongs to. The frontend store keys
    /// `chatAttachments` by session id (a workspace can have several sessions),
    /// so the listener needs this to merge the row into the correct slice.
    chat_session_id: String,
    message_id: String,
    attachment: AttachmentEventBody,
}

#[derive(Serialize, Clone)]
struct AttachmentEventBody {
    id: String,
    message_id: String,
    filename: String,
    media_type: String,
    size_bytes: i64,
    width: Option<i32>,
    height: Option<i32>,
    tool_use_id: Option<String>,
    /// Base64-encoded file bytes. Sent inline because the frontend renders
    /// directly from a data URL — re-fetching via a Tauri command would mean
    /// an extra round trip and a second copy of the BLOB across IPC.
    data_base64: String,
    caption: Option<String>,
}

#[derive(Serialize, Clone)]
struct AgentHookEvent {
    workspace_id: String,
    chat_session_id: String,
    input: serde_json::Value,
}

async fn handle_payload(
    app: AppHandle,
    db_path: PathBuf,
    workspace_id: String,
    chat_session_id: String,
    payload: BridgePayload,
) -> BridgeResponse {
    match payload {
        BridgePayload::SendAttachment {
            file_path,
            media_type,
            caption,
        } => {
            // The Claudette MCP server is now injected unconditionally so
            // its always-on scheduling tools reach every agent (see the
            // wiring in commands/chat/send.rs + remote_control.rs). The
            // "Agent Attachments" plugin toggle therefore can't gate the
            // server's mere presence anymore — it has to gate the
            // send_to_user call itself, here. Without this check,
            // disabling the plugin would still let attachments through,
            // breaking the Settings contract that turning it off removes
            // the tool. Reusing the same `is_builtin_plugin_enabled` read
            // the system-prompt nudge already consults.
            let db_for_gate = match Database::open(&db_path) {
                Ok(db) => db,
                Err(err) => {
                    return BridgeResponse::err(format!("open db: {err}"));
                }
            };
            if !claudette::agent_mcp::is_builtin_plugin_enabled(&db_for_gate, "send_to_user") {
                return BridgeResponse::err(
                    "The Agent Attachments plugin is disabled. Enable it in Settings → \
                     Plugins to deliver files inline."
                        .to_string(),
                );
            }
            drop(db_for_gate);
            send_attachment(
                app,
                db_path,
                workspace_id,
                chat_session_id,
                file_path,
                media_type,
                caption,
            )
            .await
        }
        BridgePayload::HookEvent { input } => {
            let _ = app.emit(
                "agent-hook-event",
                AgentHookEvent {
                    workspace_id,
                    chat_session_id,
                    input,
                },
            );
            BridgeResponse {
                ok: true,
                attachment_id: None,
                message: None,
                data: None,
                error: None,
            }
        }
        BridgePayload::ScheduleWakeup {
            delay_seconds,
            fire_at,
            prompt,
            reason,
        } => schedule_wakeup(
            app,
            db_path,
            chat_session_id,
            delay_seconds,
            fire_at,
            prompt,
            reason,
        ),
        BridgePayload::CronCreate {
            name,
            cron_expr,
            prompt,
            recurring,
        } => create_cron(
            app,
            db_path,
            chat_session_id,
            name,
            cron_expr,
            prompt,
            recurring,
        ),
        BridgePayload::CronList => list_crons(db_path, chat_session_id),
        BridgePayload::CronDelete { id } => delete_cron(app, db_path, chat_session_id, id),
        BridgePayload::Monitor { task_id, until } => {
            monitor_background_task(app, db_path, workspace_id, chat_session_id, task_id, until)
                .await
        }
    }
}

fn schedule_wakeup(
    app: AppHandle,
    db_path: PathBuf,
    chat_session_id: String,
    delay_seconds: Option<i64>,
    fire_at: Option<String>,
    prompt: String,
    reason: Option<String>,
) -> BridgeResponse {
    let fire_at = match resolve_fire_at(delay_seconds, fire_at.as_deref()) {
        Ok(dt) => dt,
        Err(err) => return BridgeResponse::err(err),
    };
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(err) => return BridgeResponse::err(format!("open db: {err}")),
    };
    // Agent-callable scheduling doesn't pin a backend — the cron inherits
    // the global default when it fires. Backend pinning is a frontend
    // concern (toolbar choice via `/loop` / `/schedule`); the agent itself
    // is already running on a backend and doesn't get to choose for the
    // fired turn.
    match db.create_agent_wakeup(
        &ScheduleTarget::Session(chat_session_id),
        fire_at,
        &prompt,
        reason.as_deref(),
        None,
        None,
    ) {
        Ok(task) => {
            app.state::<AppState>().scheduler_notify.notify_waiters();
            BridgeResponse::data(
                format!("Scheduled wakeup {} for {}.", task.id, fire_at.to_rfc3339()),
                serde_json::to_value(task).unwrap_or(serde_json::Value::Null),
            )
        }
        Err(err) => BridgeResponse::err(format!("schedule wakeup: {err}")),
    }
}

fn create_cron(
    app: AppHandle,
    db_path: PathBuf,
    chat_session_id: String,
    name: Option<String>,
    cron_expr: String,
    prompt: String,
    recurring: bool,
) -> BridgeResponse {
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(err) => return BridgeResponse::err(format!("open db: {err}")),
    };
    match db.create_agent_cron_task(
        &ScheduleTarget::Session(chat_session_id),
        name.as_deref(),
        &cron_expr,
        &prompt,
        recurring,
        None,
        None,
    ) {
        Ok(task) => {
            app.state::<AppState>().scheduler_notify.notify_waiters();
            BridgeResponse::data(
                format!(
                    "Scheduled routine {} ({}).",
                    task.name.as_deref().unwrap_or(&task.id),
                    task.cron_expr.as_deref().unwrap_or("")
                ),
                serde_json::to_value(task).unwrap_or(serde_json::Value::Null),
            )
        }
        Err(err) => BridgeResponse::err(format!("create cron routine: {err}")),
    }
}

fn list_crons(db_path: PathBuf, chat_session_id: String) -> BridgeResponse {
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(err) => return BridgeResponse::err(format!("open db: {err}")),
    };
    match db.list_agent_scheduled_tasks_for_chat_session(&chat_session_id) {
        Ok(tasks) => {
            let message = if tasks.is_empty() {
                "No scheduled wakeups or routines.".to_string()
            } else {
                format!("{} scheduled wakeup(s)/routine(s).", tasks.len())
            };
            BridgeResponse::data(
                message,
                serde_json::to_value(tasks).unwrap_or(serde_json::Value::Null),
            )
        }
        Err(err) => BridgeResponse::err(format!("list routines: {err}")),
    }
}

fn delete_cron(
    app: AppHandle,
    db_path: PathBuf,
    chat_session_id: String,
    id: String,
) -> BridgeResponse {
    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(err) => return BridgeResponse::err(format!("open db: {err}")),
    };
    match db.delete_agent_scheduled_task_for_chat_session(&chat_session_id, &id) {
        Ok(0) => BridgeResponse::err(format!("No scheduled routine named {id:?}")),
        Ok(n) => {
            app.state::<AppState>().scheduler_notify.notify_waiters();
            BridgeResponse::message(format!("Deleted {n} scheduled routine(s)."))
        }
        Err(err) => BridgeResponse::err(format!("delete routine: {err}")),
    }
}

async fn monitor_background_task(
    app: AppHandle,
    _db_path: PathBuf,
    workspace_id: String,
    chat_session_id: String,
    task_id: String,
    until: Option<String>,
) -> BridgeResponse {
    let target = {
        let state = app.state::<AppState>();
        let agents = state.agents.read().await;
        agents.get(&chat_session_id).and_then(|session| {
            let output_path = session.background_task_output_paths.get(&task_id)?.clone();
            let canonical_task_id = session
                .background_task_output_paths
                .iter()
                .find_map(|(candidate_id, candidate_path)| {
                    if candidate_path == &output_path
                        && session.running_background_tasks.contains(candidate_id)
                    {
                        Some(candidate_id.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| task_id.clone());
            Some((canonical_task_id, output_path))
        })
    };
    let Some((task_id, output_path)) = target else {
        return BridgeResponse::err(format!(
            "no trusted output path for background task {task_id}"
        ));
    };
    spawn_monitor_tailer(
        app,
        workspace_id,
        chat_session_id,
        task_id.clone(),
        output_path,
        until,
    );
    BridgeResponse::message(format!("Monitor armed for background task {task_id}."))
}

fn spawn_monitor_tailer(
    app: AppHandle,
    workspace_id: String,
    chat_session_id: String,
    task_id: String,
    output_path: String,
    until: Option<String>,
) {
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut offset = tokio::fs::metadata(&output_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let mut pending = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let is_running = {
                let state = app.state::<AppState>();
                let agents = state.agents.read().await;
                agents
                    .get(&chat_session_id)
                    .is_some_and(|session| session.running_background_tasks.contains(&task_id))
            };
            let Ok(mut file) = tokio::fs::File::open(&output_path).await else {
                if !is_running {
                    break;
                }
                continue;
            };
            let len = file.metadata().await.ok().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = 0;
            }
            if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
                continue;
            }
            let mut buf = vec![0_u8; 8192];
            let mut lines = Vec::new();
            loop {
                match file.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        offset += n as u64;
                        pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                        while let Some(idx) = pending.find('\n') {
                            let line = pending[..idx].trim_end_matches('\r').to_string();
                            pending = pending[idx + 1..].to_string();
                            if !line.trim().is_empty() {
                                lines.push(line);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            if !lines.is_empty() {
                wait_for_session_idle(&app, &chat_session_id).await;
                let prompt = monitor_event_prompt(&task_id, until.as_deref(), &lines);
                if let Err(err) = crate::commands::scheduling::dispatch_prompt_to_session(
                    app.clone(),
                    chat_session_id.clone(),
                    prompt,
                )
                .await
                {
                    tracing::warn!(
                        target: "claudette::scheduling",
                        workspace_id = %workspace_id,
                        chat_session_id = %chat_session_id,
                        task_id = %task_id,
                        error = %err,
                        "failed to dispatch monitor event"
                    );
                }
            }
            if !is_running && offset >= len {
                break;
            }
        }
    });
}

async fn wait_for_session_idle(app: &AppHandle, chat_session_id: &str) {
    loop {
        let is_idle = {
            let state = app.state::<AppState>();
            let agents = state.agents.read().await;
            agents
                .get(chat_session_id)
                .is_none_or(|session| session.active_pid.is_none())
        };
        if is_idle {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn monitor_event_prompt(task_id: &str, until: Option<&str>, lines: &[String]) -> String {
    let mut prompt = format!(
        "A monitored background task emitted new output.\n\n<monitor-event>\n<task-id>{}</task-id>",
        escape_xml(task_id)
    );
    if let Some(until) = until.filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("\n<until>{}</until>", escape_xml(until)));
    }
    for line in lines {
        prompt.push_str(&format!("\n<line>{}</line>", escape_xml(line)));
    }
    prompt.push_str("\n</monitor-event>");
    prompt
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn resolve_fire_at(
    delay_seconds: Option<i64>,
    fire_at: Option<&str>,
) -> Result<chrono::DateTime<chrono::Utc>, String> {
    match (delay_seconds, fire_at) {
        (Some(seconds), _) if seconds <= 0 => Err("delaySeconds must be positive".to_string()),
        (Some(seconds), _) => Ok(chrono::Utc::now() + chrono::Duration::seconds(seconds)),
        (None, Some(value)) => chrono::DateTime::parse_from_rfc3339(value)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .map_err(|e| format!("fireAt must be RFC3339: {e}")),
        (None, None) => Err("delaySeconds or fireAt is required".to_string()),
    }
}

async fn send_attachment(
    app: AppHandle,
    db_path: PathBuf,
    workspace_id: String,
    chat_session_id: String,
    file_path: String,
    media_type: String,
    caption: Option<String>,
) -> BridgeResponse {
    // Require absolute paths. The grandchild's CWD isn't user-controlled, so
    // a relative path would resolve unpredictably and could surface a file
    // the agent didn't mean to send.
    let path = std::path::Path::new(&file_path);
    if !path.is_absolute() {
        return BridgeResponse::err(format!("file_path must be absolute, got {file_path:?}"));
    }

    // Strip path components — the policy and DB only see the basename.
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // Validate size *before* reading bytes — a prompt-injected or mistaken
    // call with a multi-GB path would otherwise allocate the whole file into
    // RAM only to reject it afterward.
    let size_bytes = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m.len(),
        Err(e) => return BridgeResponse::err(format!("stat {file_path}: {e}")),
    };
    if let Err(reason) = policy(&media_type, size_bytes, &filename) {
        return BridgeResponse::err(reason);
    }

    // Now safe to read into memory — policy has bounded the size.
    let bytes = match tokio::fs::read(&file_path).await {
        Ok(b) => b,
        Err(e) => return BridgeResponse::err(format!("read {file_path}: {e}")),
    };
    // Encode for the event payload before moving `bytes` into the row so we
    // don't carry two full copies in memory at once for big PDFs.
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    // Resolve the anchor message_id from AppState. The `agents` map is keyed
    // by `chat_session_id` (a single workspace can have multiple sessions),
    // so we must look up by that — using `workspace_id` here was a latent bug
    // that meant `last_user_msg_id` was always `None` and `send_to_user`
    // always rejected with "no in-flight turn".
    let anchor_msg_id = {
        let state = app.state::<AppState>();
        let agents = state.agents.read().await;
        agents
            .get(&chat_session_id)
            .and_then(|s| s.last_user_msg_id.clone())
    };
    let Some(message_id) = anchor_msg_id else {
        return BridgeResponse::err(
            "no in-flight turn — agent attachments may only be sent during a turn",
        );
    };

    // Persist into SQLite. Open a fresh per-call connection because rusqlite
    // Connection isn't Send (matches the existing pattern in commands/).
    let attachment_id = uuid::Uuid::new_v4().to_string();
    let row = Attachment {
        id: attachment_id.clone(),
        message_id: message_id.clone(),
        filename: filename.clone(),
        media_type: media_type.clone(),
        data: bytes,
        width: None,
        height: None,
        size_bytes: size_bytes as i64,
        created_at: chrono::Utc::now().to_rfc3339(),
        origin: AttachmentOrigin::Agent,
        tool_use_id: None,
    };
    if let Err(e) = persist_row(&db_path, &row) {
        return BridgeResponse::err(format!("persist: {e}"));
    }

    // Emit the event so the chat surface re-renders.
    let evt = AgentAttachmentEvent {
        workspace_id: workspace_id.clone(),
        chat_session_id: chat_session_id.clone(),
        message_id: message_id.clone(),
        attachment: AttachmentEventBody {
            id: attachment_id.clone(),
            message_id,
            filename,
            media_type,
            size_bytes: size_bytes as i64,
            width: None,
            height: None,
            tool_use_id: None,
            data_base64,
            caption,
        },
    };
    let _ = app.emit("agent-attachment-created", evt);

    BridgeResponse::ok(attachment_id)
}

fn persist_row(db_path: &Path, row: &Attachment) -> Result<(), String> {
    let db = Database::open(db_path).map_err(|e| format!("open: {e}"))?;
    db.insert_attachment(row)
        .map_err(|e| format!("insert: {e}"))
}
