//! `get_chat_snapshot` RPC: a single read that returns enough state for a
//! WSS client to rebuild a chat session view after a disconnect or a
//! broadcast-lag event-loss. Mirrors the desktop IPC `ChatSnapshot` shape
//! in `src-tauri/src/ipc.rs` so the mobile client can share a response
//! decoder across the two transports.
//!
//! Lives in its own module so `handler.rs` (already past 1800 lines) only
//! grows by a small dispatch arm — see the "god file — keep diffs surgical"
//! note in CLAUDE.md.
//!
//! The key piece is `pending_controls`: it surfaces the in-memory
//! `pending_permissions` map for the session, giving a client a way to
//! recover from a missed `agent-permission-prompt` broadcast event.

use std::collections::HashMap;

use claudette::db::Database;
use claudette::model::{
    AgentStatus, Attachment, AttachmentOrigin, AttentionKind, ChatMessage, ChatRole, ChatSession,
    CompletedTurnData,
};
use serde::Serialize;

use crate::ws::{AgentSessionState, ServerState};

pub const DEFAULT_SNAPSHOT_LIMIT: i64 = 50;
pub const MAX_SNAPSHOT_LIMIT: i64 = 200;

/// Per-attachment cap for inlined text bodies. Mirrors
/// `MAX_TEXT_ATTACHMENT_INLINE_BYTES` in the desktop IPC.
const MAX_TEXT_ATTACHMENT_INLINE_BYTES: usize = 16 * 1024;
/// Per-response budget for inlined text bodies, summed across all
/// attachments in this snapshot. Mirrors `MAX_ATTACHMENT_INLINE_BYTES_PER_RESPONSE`.
const MAX_ATTACHMENT_INLINE_BYTES_PER_RESPONSE: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ChatSnapshot {
    pub session: ChatSession,
    pub messages: Vec<ChatMessage>,
    pub attachments: Vec<WssAttachment>,
    pub completed_turns: Vec<CompletedTurnData>,
    pub pending_controls: Vec<PendingAgentControl>,
    pub has_more: bool,
    pub total_count: i64,
}

/// Attachment metadata safe to send inline in a JSON-RPC response.
/// Binary or oversize bodies have `text_content = None`; a follow-up
/// `load_attachment_data` WSS RPC is needed to fetch raw bytes.
#[derive(Debug, Clone, Serialize)]
pub struct WssAttachment {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub media_type: String,
    pub text_content: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub size_bytes: i64,
    pub created_at: String,
    pub origin: AttachmentOrigin,
    pub tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PendingAgentControl {
    pub tool_use_id: String,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub kind: PendingAgentControlKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingAgentControlKind {
    AskUserQuestion,
    ExitPlanMode,
    /// Forward-compatible bucket for future Claude tool-control kinds.
    Unknown,
}

/// Clamp a raw `limit` param to the supported range; default when absent.
pub fn clamp_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(DEFAULT_SNAPSHOT_LIMIT)
        .clamp(1, MAX_SNAPSHOT_LIMIT)
}

/// Project the in-memory `pending_permissions` map for a session into the
/// wire shape. Sorted by `tool_use_id` for deterministic ordering across
/// reconnects.
pub fn pending_controls_for_session(agent: Option<&AgentSessionState>) -> Vec<PendingAgentControl> {
    let Some(agent) = agent else {
        return Vec::new();
    };
    let mut out: Vec<PendingAgentControl> = agent
        .pending_permissions
        .iter()
        .map(|(tool_use_id, pending)| PendingAgentControl {
            tool_use_id: tool_use_id.clone(),
            tool_name: pending.tool_name.clone(),
            input: pending.original_input.clone(),
            kind: match pending.tool_name.as_str() {
                "AskUserQuestion" => PendingAgentControlKind::AskUserQuestion,
                "ExitPlanMode" => PendingAgentControlKind::ExitPlanMode,
                _ => PendingAgentControlKind::Unknown,
            },
        })
        .collect();
    out.sort_by(|a, b| a.tool_use_id.cmp(&b.tool_use_id));
    out
}

/// Assemble a `ChatSnapshot` for the given session. Returns `Err("Session not found")`
/// if the chat session does not exist.
pub async fn build(
    state: &ServerState,
    chat_session_id: &str,
    limit: i64,
    before_message_id: Option<&str>,
) -> Result<ChatSnapshot, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Session not found".to_string())?;

    // Peek-and-trim for has_more: fetch one extra row, drop it if present.
    // Avoids a separate "is there an older message?" query.
    let mut messages = db
        .list_chat_messages_page(chat_session_id, limit + 1, before_message_id)
        .map_err(|e| e.to_string())?;
    let has_more = trim_peeked_message_page(&mut messages, limit);

    let total_count = db
        .count_chat_messages_for_session(chat_session_id)
        .map_err(|e| e.to_string())?;
    let completed_turns = db
        .list_completed_turns_for_session(chat_session_id)
        .map_err(|e| e.to_string())?;

    let attachments = load_safe_attachments_for_messages(&db, chat_session_id, &messages)?;

    let (pending_controls, session) = {
        let agents = state.agents.read().await;
        let agent = agents.get(chat_session_id);
        (
            pending_controls_for_session(agent),
            hydrate_session_runtime(session, agent),
        )
    };

    Ok(ChatSnapshot {
        session,
        messages,
        attachments,
        completed_turns,
        pending_controls,
        has_more,
        total_count,
    })
}

/// Overlay live agent state (status + attention) onto a session loaded from
/// the DB, mirroring the desktop's `hydrate_session` in `src-tauri/src/ipc.rs`.
/// `ChatSession::agent_status` / `needs_attention` / `attention_kind` are
/// runtime-only fields the DB always returns as `Idle` / `false` / `None`;
/// without this overlay the snapshot would report an actively-running
/// session as idle, defeating the recovery use case.
///
/// The server's `AgentSessionState` is leaner than the desktop's (no
/// `running_background_tasks`, no pre-computed attention fields), so this
/// derives `needs_attention` / `attention_kind` from `pending_permissions`
/// and collapses status to `Running` vs `Idle`.
fn hydrate_session_runtime(
    mut session: ChatSession,
    agent: Option<&AgentSessionState>,
) -> ChatSession {
    let Some(agent) = agent else {
        return session;
    };
    session.agent_status = if agent.active_pid.is_some() {
        AgentStatus::Running
    } else {
        AgentStatus::Idle
    };
    session.needs_attention = !agent.pending_permissions.is_empty();
    session.attention_kind = attention_kind_from_pending(&agent.pending_permissions);
    session
}

/// `ExitPlanMode` outranks `AskUserQuestion` because plan approval blocks
/// the whole turn until the user decides — clients should surface it first.
fn attention_kind_from_pending(
    pending: &std::collections::HashMap<String, crate::ws::PendingPermission>,
) -> Option<AttentionKind> {
    let mut has_ask = false;
    for p in pending.values() {
        match p.tool_name.as_str() {
            "ExitPlanMode" => return Some(AttentionKind::Plan),
            "AskUserQuestion" => has_ask = true,
            _ => {}
        }
    }
    if has_ask {
        Some(AttentionKind::Ask)
    } else {
        None
    }
}

fn trim_peeked_message_page(messages: &mut Vec<ChatMessage>, limit: i64) -> bool {
    let has_more = messages.len() as i64 > limit;
    if has_more {
        messages.remove(0);
    }
    has_more
}

/// Hydrate attachment metadata for the loaded message page, mirroring the
/// desktop's safe-inline rules. Walks the optional preceding user message
/// for the agent-attachment carryover case (turn boundary mid-page).
fn load_safe_attachments_for_messages(
    db: &Database,
    chat_session_id: &str,
    messages: &[ChatMessage],
) -> Result<Vec<WssAttachment>, String> {
    let mut message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let mut carry_over_user_id: Option<String> = None;

    // If the page starts on a non-user message, the preceding user message
    // (on the previous page) may carry agent-authored attachments — pull
    // just those so the visible assistant turn renders with its tool output.
    if let Some(first) = messages.first()
        && first.role != ChatRole::User
        && let Some(prev_user) = db
            .previous_user_message_id(chat_session_id, &first.id)
            .map_err(|e| e.to_string())?
    {
        message_ids.push(prev_user.clone());
        carry_over_user_id = Some(prev_user);
    }

    let message_order: HashMap<&str, usize> = message_ids
        .iter()
        .enumerate()
        .map(|(idx, id)| (id.as_str(), idx))
        .collect();
    // TODO(perf): `list_attachments_for_messages` pulls full BLOB bytes for
    // every attachment, even ones that will be returned as metadata-only.
    // A metadata-first query (skipping `data`) followed by a targeted body
    // fetch for inlineable candidates would avoid materializing large
    // images/PDFs in server memory on every recovery call. Same shape
    // applies to the desktop IPC path — should land as a shared
    // `claudette::db` change in a follow-up.
    let att_map = db
        .list_attachments_for_messages(&message_ids)
        .map_err(|e| e.to_string())?;

    // Flatten + filter carryover, then sort BEFORE walking the inline budget.
    // HashMap iteration is nondeterministic, so consuming the 512 KB budget
    // during iteration would let different attachments receive `text_content`
    // across reconnects — breaking the recovery use case this RPC exists for.
    let mut flattened: Vec<Attachment> = att_map
        .into_iter()
        .flat_map(|(msg_id, atts)| {
            let is_carry_over = carry_over_user_id.as_deref() == Some(msg_id.as_str());
            atts.into_iter()
                .filter(move |att| !is_carry_over || att.origin == AttachmentOrigin::Agent)
        })
        .collect();
    flattened.sort_by(|a, b| {
        message_order
            .get(a.message_id.as_str())
            .cmp(&message_order.get(b.message_id.as_str()))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.filename.cmp(&b.filename))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut remaining_inline_bytes = MAX_ATTACHMENT_INLINE_BYTES_PER_RESPONSE;
    let out = flattened
        .into_iter()
        .map(|att| safe_attachment(att, &mut remaining_inline_bytes))
        .collect();
    Ok(out)
}

fn safe_attachment(att: Attachment, remaining_inline_bytes: &mut usize) -> WssAttachment {
    let can_inline = is_text_attachment(&att.media_type)
        && att.data.len() <= MAX_TEXT_ATTACHMENT_INLINE_BYTES
        && att.data.len() <= *remaining_inline_bytes;
    // Validate UTF-8 BEFORE charging the budget — a mislabeled text/* file
    // that decodes as None must not lock out later valid text attachments.
    let text_content = if can_inline {
        match std::str::from_utf8(&att.data) {
            Ok(s) => {
                *remaining_inline_bytes = remaining_inline_bytes.saturating_sub(att.data.len());
                Some(s.to_owned())
            }
            Err(_) => None,
        }
    } else {
        None
    };
    WssAttachment {
        id: att.id,
        message_id: att.message_id,
        filename: att.filename,
        media_type: att.media_type,
        text_content,
        width: att.width,
        height: att.height,
        size_bytes: att.size_bytes,
        created_at: att.created_at,
        origin: att.origin,
        tool_use_id: att.tool_use_id,
    }
}

fn is_text_attachment(media_type: &str) -> bool {
    matches!(
        media_type,
        "text/plain" | "text/csv" | "text/markdown" | "application/json"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_limit_defaults_when_absent() {
        assert_eq!(clamp_limit(None), DEFAULT_SNAPSHOT_LIMIT);
    }

    #[test]
    fn clamp_limit_caps_oversize_requests() {
        assert_eq!(clamp_limit(Some(500)), MAX_SNAPSHOT_LIMIT);
        assert_eq!(clamp_limit(Some(i64::MAX)), MAX_SNAPSHOT_LIMIT);
    }

    #[test]
    fn clamp_limit_floors_at_one() {
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(-10)), 1);
    }

    #[test]
    fn clamp_limit_passes_through_in_range() {
        assert_eq!(clamp_limit(Some(1)), 1);
        assert_eq!(clamp_limit(Some(50)), 50);
        assert_eq!(clamp_limit(Some(200)), 200);
    }

    #[test]
    fn pending_controls_for_missing_session_is_empty() {
        let out = pending_controls_for_session(None);
        assert!(out.is_empty());
    }

    #[test]
    fn pending_control_kind_serializes_snake_case() {
        let json = serde_json::to_string(&PendingAgentControlKind::AskUserQuestion).unwrap();
        assert_eq!(json, "\"ask_user_question\"");
        let json = serde_json::to_string(&PendingAgentControlKind::ExitPlanMode).unwrap();
        assert_eq!(json, "\"exit_plan_mode\"");
        let json = serde_json::to_string(&PendingAgentControlKind::Unknown).unwrap();
        assert_eq!(json, "\"unknown\"");
    }
}
