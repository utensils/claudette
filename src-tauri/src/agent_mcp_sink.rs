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
use std::path::PathBuf;
use std::pin::Pin;

use base64::Engine;
use claudette::agent_mcp::bridge::Sink;
use claudette::agent_mcp::protocol::{BridgePayload, BridgeResponse};
use claudette::agent_mcp::tools::send_to_user::policy;
use claudette::db::Database;
use claudette::model::{Attachment, AttachmentOrigin};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Tauri-side implementation of [`Sink`] — one per persistent agent session.
pub struct ChatBridgeSink {
    pub app: AppHandle,
    pub db_path: PathBuf,
    pub workspace_id: String,
}

impl Sink for ChatBridgeSink {
    fn handle(
        &self,
        payload: BridgePayload,
    ) -> Pin<Box<dyn Future<Output = BridgeResponse> + Send + '_>> {
        let app = self.app.clone();
        let db_path = self.db_path.clone();
        let workspace_id = self.workspace_id.clone();
        Box::pin(async move { handle_payload(app, db_path, workspace_id, payload).await })
    }
}

#[derive(Serialize, Clone)]
struct AgentAttachmentEvent {
    workspace_id: String,
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

async fn handle_payload(
    app: AppHandle,
    db_path: PathBuf,
    workspace_id: String,
    payload: BridgePayload,
) -> BridgeResponse {
    match payload {
        BridgePayload::SendAttachment {
            file_path,
            media_type,
            caption,
        } => send_attachment(app, db_path, workspace_id, file_path, media_type, caption).await,
    }
}

async fn send_attachment(
    app: AppHandle,
    db_path: PathBuf,
    workspace_id: String,
    file_path: String,
    media_type: String,
    caption: Option<String>,
) -> BridgeResponse {
    // Read file from disk (async, off the listener task).
    let bytes = match tokio::fs::read(&file_path).await {
        Ok(b) => b,
        Err(e) => return BridgeResponse::err(format!("read {file_path}: {e}")),
    };
    let size_bytes = bytes.len() as u64;

    // Strip path components — the policy and DB only see the basename.
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // Validate against the agent-side policy. Rejected files come back to the
    // model as a tool-error so it can adjust and retry.
    if let Err(reason) = policy(&media_type, size_bytes, &filename) {
        return BridgeResponse::err(reason);
    }

    // Resolve the anchor message_id from AppState.
    let anchor_msg_id = {
        let state = app.state::<AppState>();
        let agents = state.agents.read().await;
        agents
            .get(&workspace_id)
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
        data: bytes.clone(),
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
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            caption,
        },
    };
    let _ = app.emit("agent-attachment-created", evt);

    BridgeResponse::ok(attachment_id)
}

fn persist_row(db_path: &PathBuf, row: &Attachment) -> Result<(), String> {
    let db = Database::open(db_path).map_err(|e| format!("open: {e}"))?;
    db.insert_attachment(row)
        .map_err(|e| format!("insert: {e}"))
}
