use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use claudette_core::agent::{self, AgentEvent, StreamEvent};
use claudette_core::db::Database;
use claudette_core::model::{ChatMessage, ChatRole};

use crate::state::{AgentSessionState, AppState};

#[derive(Clone, Serialize)]
struct AgentStreamPayload {
    workspace_id: String,
    event: AgentEvent,
}

/// Map a permission level name to the list of tools to pre-approve.
fn tools_for_level(level: &str) -> Vec<String> {
    match level {
        "full" => [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
            "NotebookEdit",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        "standard" => [
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        // "readonly" or anything else
        _ => ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
    }
}

#[tauri::command]
pub async fn load_chat_history(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_chat_messages(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_chat_message(
    workspace_id: String,
    content: String,
    permission_level: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Look up workspace for worktree path.
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?
        .clone();

    // Save user message to DB.
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.clone(),
        role: ChatRole::User,
        content: content.clone(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
    };
    db.insert_chat_message(&user_msg)
        .map_err(|e| e.to_string())?;

    // Resolve allowed tools from permission level.
    let level = permission_level.as_deref().unwrap_or("readonly");
    if !matches!(level, "readonly" | "standard" | "full") {
        eprintln!("[chat] Unknown permission level {level:?}, falling back to readonly");
    }
    let allowed_tools = tools_for_level(level);

    // Get or create agent session.
    let mut agents = state.agents.write().await;
    let session = agents
        .entry(workspace_id.clone())
        .or_insert_with(|| AgentSessionState {
            session_id: uuid::Uuid::new_v4().to_string(),
            turn_count: 0,
            active_pid: None,
        });

    let is_resume = session.turn_count > 0;
    let session_id = session.session_id.clone();
    session.turn_count += 1;

    // Spawn the agent turn.
    let turn_handle = agent::run_turn(
        std::path::Path::new(&worktree_path),
        &session_id,
        &content,
        is_resume,
        &allowed_tools,
    )
    .await?;

    session.active_pid = Some(turn_handle.pid);
    drop(agents);

    // Bridge: read from mpsc receiver, emit Tauri events.
    let ws_id = workspace_id.clone();
    let db_path = state.db_path.clone();
    tokio::spawn(async move {
        let mut rx = turn_handle.event_rx;
        while let Some(event) = rx.recv().await {
            // Persist assistant messages to DB on completion.
            if let AgentEvent::Stream(StreamEvent::Assistant { ref message }) = event {
                let full_text: String = message
                    .content
                    .iter()
                    .filter_map(|block| {
                        if let claudette_core::agent::ContentBlock::Text { text } = block {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("");

                if let Ok(db) = Database::open(&db_path) {
                    let msg = ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: ws_id.clone(),
                        role: ChatRole::Assistant,
                        content: full_text,
                        cost_usd: None,
                        duration_ms: None,
                        created_at: now_iso(),
                    };
                    let _ = db.insert_chat_message(&msg);
                }
            }

            // Update cost/duration on result events.
            if let AgentEvent::Stream(StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                ..
            }) = &event
                && let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms)
                && let Ok(db) = Database::open(&db_path)
                && let Ok(msgs) = db.list_chat_messages(&ws_id)
                && let Some(last) = msgs.last()
            {
                let _ = db.update_chat_message_cost(&last.id, *cost, *dur);
            }

            let payload = AgentStreamPayload {
                workspace_id: ws_id.clone(),
                event,
            };
            let _ = app.emit("agent-stream", &payload);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_agent(workspace_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(&workspace_id)
        && let Some(pid) = session.active_pid.take()
    {
        agent::stop_agent(pid).await?;
    }

    // Log stop message.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        role: ChatRole::System,
        content: "Agent stopped".to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
    };
    db.insert_chat_message(&msg).map_err(|e| e.to_string())?;

    Ok(())
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
