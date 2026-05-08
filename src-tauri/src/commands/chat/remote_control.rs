use std::sync::Arc;

use claudette::agent::{
    AgentEvent, PersistentSession, StreamEvent, TokenUsage, UserContentBlock, UserEventMessage,
    UserMessageContent,
};
use claudette::chat::{
    BuildAssistantArgs, CheckpointArgs, build_assistant_chat_message, create_turn_checkpoint,
    extract_assistant_text, extract_event_thinking,
};
use claudette::db::Database;
use claudette::model::{ChatMessage, ChatRole};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{AppState, ClaudeRemoteControlLifecycle, ClaudeRemoteControlStatus};

use super::{AgentStreamPayload, now_iso};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChatTurnStartedPayload<'a> {
    workspace_id: &'a str,
    chat_session_id: &'a str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRemoteControlStatusPayload {
    workspace_id: String,
    chat_session_id: String,
    status: ClaudeRemoteControlStatus,
}

#[tauri::command]
pub async fn get_claude_remote_control_status(
    chat_session_id: String,
    state: State<'_, AppState>,
) -> Result<ClaudeRemoteControlStatus, String> {
    let agents = state.agents.read().await;
    Ok(agents
        .get(&chat_session_id)
        .map(|session| session.claude_remote_control.clone())
        .unwrap_or_else(ClaudeRemoteControlStatus::disabled))
}

#[tauri::command]
pub async fn set_claude_remote_control(
    chat_session_id: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaudeRemoteControlStatus, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();
    let workspace = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|ws| ws.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = workspace
        .worktree_path
        .clone()
        .ok_or("Workspace has no worktree")?;

    let (ps, pid) = {
        let mut agents = state.agents.write().await;
        let session = agents
            .get_mut(&chat_session_id)
            .ok_or("Send a message first, then enable Claude Remote Control.")?;
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Send a message first, then enable Claude Remote Control.")?;
        let pid = ps.pid();
        session.claude_remote_control = if enabled {
            ClaudeRemoteControlStatus {
                state: ClaudeRemoteControlLifecycle::Enabling,
                ..session.claude_remote_control.clone()
            }
        } else {
            session.claude_remote_control.clone()
        };
        (ps, pid)
    };

    if enabled {
        emit_remote_control_status(&app, &workspace_id, &chat_session_id, &state).await;
    }

    match ps.set_remote_control(enabled).await {
        Ok(response) => {
            let status = if enabled {
                status_from_control_response(response.response.as_ref())
            } else {
                ClaudeRemoteControlStatus::disabled()
            };
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                .await;
            if enabled {
                ensure_remote_control_monitor(
                    app.clone(),
                    state.db_path.clone(),
                    workspace_id.clone(),
                    chat_session_id.clone(),
                    worktree_path,
                    pid,
                    ps,
                )
                .await;
            }
            Ok(get_stored_status(&state, &chat_session_id).await)
        }
        Err(err) => {
            let status = ClaudeRemoteControlStatus {
                state: ClaudeRemoteControlLifecycle::Error,
                session_url: None,
                connect_url: None,
                environment_id: None,
                detail: None,
                last_error: Some(err.clone()),
            };
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                .await;
            Err(err)
        }
    }
}

async fn get_stored_status(
    state: &State<'_, AppState>,
    chat_session_id: &str,
) -> ClaudeRemoteControlStatus {
    let agents = state.agents.read().await;
    agents
        .get(chat_session_id)
        .map(|session| session.claude_remote_control.clone())
        .unwrap_or_else(ClaudeRemoteControlStatus::disabled)
}

async fn store_remote_control_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    workspace_id: &str,
    chat_session_id: &str,
    status: ClaudeRemoteControlStatus,
) {
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(chat_session_id) {
            session.claude_remote_control = status;
        }
    }
    emit_remote_control_status(app, workspace_id, chat_session_id, state).await;
}

async fn emit_remote_control_status(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    state: &State<'_, AppState>,
) {
    let status = get_stored_status(state, chat_session_id).await;
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
}

fn status_from_control_response(response: Option<&serde_json::Value>) -> ClaudeRemoteControlStatus {
    ClaudeRemoteControlStatus {
        state: ClaudeRemoteControlLifecycle::Ready,
        session_url: response.and_then(|v| string_field(v, "session_url")),
        connect_url: response.and_then(|v| string_field(v, "connect_url")),
        environment_id: response.and_then(|v| string_field(v, "environment_id")),
        detail: None,
        last_error: None,
    }
}

fn string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

async fn ensure_remote_control_monitor(
    app: AppHandle,
    db_path: std::path::PathBuf,
    workspace_id: String,
    chat_session_id: String,
    worktree_path: String,
    pid: u32,
    ps: Arc<PersistentSession>,
) {
    let app_state = app.state::<AppState>();
    {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(&chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid == Some(pid) {
            return;
        }
        session.claude_remote_control_monitor_pid = Some(pid);
    }

    tokio::spawn(async move {
        let mut rx = ps.subscribe();
        let mut remote_turn_active = false;
        let mut remote_user_msg_id: Option<String> = None;
        let mut last_assistant_msg_id: Option<String> = None;
        let mut pending_thinking: Option<String> = None;
        let mut latest_usage: Option<TokenUsage> = None;

        loop {
            let event = match rx.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };

            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                state,
                detail,
                ..
            }) = &event
                && subtype == "bridge_state"
            {
                update_status_from_bridge_state(
                    &app,
                    &workspace_id,
                    &chat_session_id,
                    pid,
                    state.as_deref(),
                    detail.as_deref(),
                )
                .await;
            }

            if let AgentEvent::ProcessExited(_) = &event {
                clear_monitor_on_exit(&app, &workspace_id, &chat_session_id, pid).await;
                if remote_turn_active {
                    emit_agent_stream(&app, &workspace_id, &chat_session_id, event);
                }
                break;
            }

            if !remote_turn_active {
                match remote_monitor_turn_gate(&app, &chat_session_id, pid).await {
                    RemoteMonitorTurnGate::Idle => {}
                    RemoteMonitorTurnGate::Busy => continue,
                    RemoteMonitorTurnGate::Stale => break,
                }
                let AgentEvent::Stream(StreamEvent::User {
                    message,
                    is_synthetic: false,
                }) = &event
                else {
                    continue;
                };
                let Some(text) = user_visible_text(message) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    chat_session_id: chat_session_id.clone(),
                    role: ChatRole::User,
                    content: text,
                    cost_usd: None,
                    duration_ms: None,
                    created_at: now_iso(),
                    thinking: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_creation_tokens: None,
                };
                if let Ok(db) = Database::open(&db_path) {
                    let _ = db.insert_chat_message(&msg);
                }
                {
                    let app_state = app.state::<AppState>();
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&chat_session_id) {
                        session.active_pid = Some(pid);
                        session.turn_count = session.turn_count.saturating_add(1);
                        session.last_user_msg_id = Some(msg.id.clone());
                        if let Ok(db) = Database::open(&db_path) {
                            let _ = db.save_chat_session_state(
                                &chat_session_id,
                                &session.session_id,
                                session.turn_count,
                            );
                            let _ = db
                                .update_agent_session_turn(&session.session_id, session.turn_count);
                        }
                    }
                }
                let _ = app.emit("chat-message", &msg);
                let _ = app.emit(
                    "chat-turn-started",
                    &RemoteChatTurnStartedPayload {
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                    },
                );
                crate::tray::rebuild_tray(&app);
                remote_turn_active = true;
                remote_user_msg_id = Some(msg.id);
            }

            if let AgentEvent::Stream(StreamEvent::Stream {
                event: claudette::agent::InnerStreamEvent::MessageDelta { usage: Some(u) },
            }) = &event
            {
                latest_usage = Some(u.clone());
            }

            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                compact_metadata: Some(meta),
                ..
            }) = &event
                && subtype == "compact_boundary"
                && let Ok(db) = Database::open(&db_path)
            {
                let msg = claudette::chat::build_compaction_sentinel(
                    &workspace_id,
                    &chat_session_id,
                    meta,
                    now_iso(),
                );
                let _ = db.insert_chat_message(&msg);
            }

            if let AgentEvent::Stream(StreamEvent::User {
                message,
                is_synthetic: true,
            }) = &event
                && let UserMessageContent::Text(body) = &message.content
                && let Ok(db) = Database::open(&db_path)
            {
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    chat_session_id: chat_session_id.clone(),
                    role: ChatRole::System,
                    content: format!("SYNTHETIC_SUMMARY:\n{body}"),
                    cost_usd: None,
                    duration_ms: None,
                    created_at: now_iso(),
                    thinking: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_creation_tokens: None,
                };
                let _ = db.insert_chat_message(&msg);
            }

            if let AgentEvent::Stream(StreamEvent::Assistant { message }) = &event {
                let full_text = extract_assistant_text(message);
                if let Some(t) = extract_event_thinking(message) {
                    pending_thinking = Some(match pending_thinking.take() {
                        Some(mut existing) => {
                            existing.push_str(&t);
                            existing
                        }
                        None => t,
                    });
                }
                if !full_text.trim().is_empty()
                    && let Ok(db) = Database::open(&db_path)
                {
                    let msg = build_assistant_chat_message(BuildAssistantArgs {
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                        content: full_text,
                        thinking: pending_thinking.take(),
                        usage: latest_usage.take(),
                        created_at: now_iso(),
                    });
                    let msg_id = msg.id.clone();
                    if db.insert_chat_message(&msg).is_ok() {
                        last_assistant_msg_id = Some(msg_id);
                    }
                }
            }

            if let AgentEvent::Stream(StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                usage,
                ..
            }) = &event
            {
                if let Ok(db) = Database::open(&db_path)
                    && let Some(ref msg_id) = last_assistant_msg_id
                {
                    if let Some(usage) = usage {
                        let _ = db.update_chat_message_usage_if_missing(
                            msg_id,
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.cache_read_input_tokens,
                            usage.cache_creation_input_tokens,
                        );
                    }
                    if let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms) {
                        let _ = db.update_chat_message_cost(msg_id, *cost, *dur);
                    }
                }

                let anchor_msg_id = last_assistant_msg_id
                    .as_deref()
                    .or(remote_user_msg_id.as_deref())
                    .unwrap_or("");
                if !anchor_msg_id.is_empty()
                    && let Some(cp) = create_turn_checkpoint(CheckpointArgs {
                        db_path: &db_path,
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                        anchor_msg_id,
                        worktree_path: &worktree_path,
                        created_at: now_iso(),
                    })
                    .await
                {
                    let payload = serde_json::json!({
                        "workspace_id": &workspace_id,
                        "chat_session_id": &chat_session_id,
                        "checkpoint": &cp,
                    });
                    let _ = app.emit("checkpoint-created", &payload);
                }
            }

            let is_done = matches!(&event, AgentEvent::Stream(StreamEvent::Result { .. }));
            emit_agent_stream(&app, &workspace_id, &chat_session_id, event);

            if is_done {
                {
                    let app_state = app.state::<AppState>();
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&chat_session_id)
                        && session.active_pid == Some(pid)
                    {
                        session.active_pid = None;
                    }
                }
                crate::tray::rebuild_tray(&app);
                remote_turn_active = false;
                remote_user_msg_id = None;
                last_assistant_msg_id = None;
                pending_thinking = None;
                latest_usage = None;
            }
        }
    });
}

enum RemoteMonitorTurnGate {
    Idle,
    Busy,
    Stale,
}

async fn remote_monitor_turn_gate(
    app: &AppHandle,
    chat_session_id: &str,
    pid: u32,
) -> RemoteMonitorTurnGate {
    let app_state = app.state::<AppState>();
    let agents = app_state.agents.read().await;
    let Some(session) = agents.get(chat_session_id) else {
        return RemoteMonitorTurnGate::Stale;
    };
    if session.claude_remote_control_monitor_pid != Some(pid)
        || session
            .persistent_session
            .as_ref()
            .is_none_or(|ps| ps.pid() != pid)
    {
        return RemoteMonitorTurnGate::Stale;
    }
    if session.active_pid == Some(pid) {
        RemoteMonitorTurnGate::Busy
    } else {
        RemoteMonitorTurnGate::Idle
    }
}

fn user_visible_text(message: &UserEventMessage) -> Option<String> {
    match &message.content {
        UserMessageContent::Text(text) => Some(text.clone()),
        UserMessageContent::Blocks(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| match block {
                    UserContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
    }
}

fn emit_agent_stream(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    event: AgentEvent,
) {
    let payload = AgentStreamPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        event,
    };
    let _ = app.emit("agent-stream", &payload);
}

async fn update_status_from_bridge_state(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    pid: u32,
    bridge_state: Option<&str>,
    detail: Option<&str>,
) {
    let app_state = app.state::<AppState>();
    let status = {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid != Some(pid) {
            return;
        }
        if matches!(
            session.claude_remote_control.state,
            ClaudeRemoteControlLifecycle::Disabled
        ) {
            return;
        }
        let next_state = match bridge_state.unwrap_or_default() {
            "connected" => ClaudeRemoteControlLifecycle::Connected,
            "reconnecting" | "retrying" => ClaudeRemoteControlLifecycle::Reconnecting,
            "error" | "failed" => ClaudeRemoteControlLifecycle::Error,
            "ready" | "listening" | "initialized" => ClaudeRemoteControlLifecycle::Ready,
            _ => session.claude_remote_control.state,
        };
        session.claude_remote_control.state = next_state;
        session.claude_remote_control.detail = detail.map(ToOwned::to_owned);
        if next_state != ClaudeRemoteControlLifecycle::Error {
            session.claude_remote_control.last_error = None;
        } else if session.claude_remote_control.last_error.is_none() {
            session.claude_remote_control.last_error = detail.map(ToOwned::to_owned);
        }
        session.claude_remote_control.clone()
    };
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
}

async fn clear_monitor_on_exit(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    pid: u32,
) {
    let app_state = app.state::<AppState>();
    let status = {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid == Some(pid) {
            session.claude_remote_control_monitor_pid = None;
        }
        if session
            .persistent_session
            .as_ref()
            .is_some_and(|ps| ps.pid() == pid)
        {
            session.persistent_session = None;
            session.mcp_bridge = None;
        }
        session.active_pid = None;
        session.claude_remote_control = ClaudeRemoteControlStatus::disabled();
        session.claude_remote_control.clone()
    };
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
    crate::tray::rebuild_tray(app);
}

#[cfg(test)]
mod tests {
    use super::{status_from_control_response, user_visible_text};
    use crate::state::ClaudeRemoteControlLifecycle;
    use claudette::agent::{UserContentBlock, UserEventMessage, UserMessageContent};

    #[test]
    fn status_from_control_response_extracts_urls() {
        let response = serde_json::json!({
            "session_url": "https://claude.ai/session/abc",
            "connect_url": "https://claude.ai/connect/abc",
            "environment_id": "env_123"
        });

        let status = status_from_control_response(Some(&response));

        assert_eq!(status.state, ClaudeRemoteControlLifecycle::Ready);
        assert_eq!(
            status.session_url.as_deref(),
            Some("https://claude.ai/session/abc")
        );
        assert_eq!(
            status.connect_url.as_deref(),
            Some("https://claude.ai/connect/abc")
        );
        assert_eq!(status.environment_id.as_deref(), Some("env_123"));
    }

    #[test]
    fn user_visible_text_extracts_text_blocks() {
        let message = UserEventMessage {
            content: UserMessageContent::Blocks(vec![
                UserContentBlock::Text {
                    text: "one".to_string(),
                },
                UserContentBlock::Text {
                    text: "two".to_string(),
                },
            ]),
        };

        assert_eq!(user_visible_text(&message).as_deref(), Some("one\ntwo"));
    }
}
