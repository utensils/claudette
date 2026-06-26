use std::sync::Arc;

use tauri::State;

use claudette::agent::{
    AgentSession, build_codex_approval_response_payload, build_codex_user_input_response_payload,
    is_codex_approval_tool_name,
};

use crate::state::{AgentSessionState, AppState, PendingPermission};

#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(app, state),
    fields(chat_session_id = %session_id),
)]
pub async fn clear_attention(
    session_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let chat_session_id = session_id;

    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(&chat_session_id)
        && session.needs_attention
    {
        // Full reset (not just `needs_attention = false`) so the next
        // attention cycle on this session can fire its notification —
        // see AgentSessionState::reset_attention.
        session.reset_attention();
        drop(agents);
        crate::tray::rebuild_tray(&app);
    }
    Ok(())
}

/// Resolve a pending AskUserQuestion `can_use_tool` request with the user's
/// answers. `answers` is keyed by question text (matching the CLI's
/// `mapToolResultToToolResultBlockParam` expectation) and layered onto the
/// original tool input as `updatedInput`. The CLI then runs the tool's
/// `call(updatedInput)` which produces the real tool_result.
#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(answers, annotations, state),
    fields(chat_session_id = %session_id, tool_use_id = %tool_use_id),
)]
pub async fn submit_agent_answer(
    session_id: String,
    tool_use_id: String,
    answers: std::collections::HashMap<String, String>,
    annotations: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // MCP-origin branch: when the question came from the `ask_user` MCP tool
    // the agent is suspended inside its tool call (not on the CLI's stdin), so
    // the answer must be routed to the awaiting oneshot, not a control_response.
    if state.is_mcp_pending(&tool_use_id).await {
        // Return the answers map directly (keyed by question text), matching the
        // `ask_user` tool's documented contract. `annotations` is always null on
        // the MCP path (the card never sends it), so there's nothing to carry.
        return submit_mcp_answer(
            state.inner(),
            &session_id,
            &tool_use_id,
            "AskUserQuestion",
            serde_json::to_value(&answers).unwrap_or(serde_json::Value::Null),
        )
        .await;
    }

    // Validate everything BEFORE removing the pending entry: if the session
    // has been torn down or the entry maps to the wrong tool, the entry must
    // stay so the user (or the correct submit_* command) can still see it.
    let (pending, ps) = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(&session_id).ok_or("Session not found")?;
        // 1. Persistent session must be alive — otherwise nobody is reading
        //    stdin and the response would be discarded.
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Agent session is not active")?;
        // 2. Tool kind must match — peek by reference.
        match session.pending_permissions.get(&tool_use_id) {
            None => {
                let pending_ids: Vec<String> =
                    session.pending_permissions.keys().cloned().collect();
                return Err(format!(
                    "No pending permission request for tool_use_id {tool_use_id} (pending: {pending_ids:?})"
                ));
            }
            Some(p) if p.tool_name != "AskUserQuestion" => {
                return Err(format!(
                    "Pending tool for {tool_use_id} is {}, not AskUserQuestion",
                    p.tool_name
                ));
            }
            _ => {}
        }
        // 3. All checks passed — now it is safe to remove.
        let pending = session
            .pending_permissions
            .remove(&tool_use_id)
            .expect("checked above");
        session.reset_attention();
        (pending, ps)
    };

    // Layer answers (and annotations, if any) onto the original input.
    let mut updated_input = pending.original_input.clone();
    if !updated_input.is_object() {
        updated_input = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(obj) = updated_input.as_object_mut() {
        let answers_value =
            serde_json::to_value(&answers).map_err(|e| format!("Failed to encode answers: {e}"))?;
        obj.insert("answers".to_string(), answers_value);
        if let Some(ann) = annotations {
            obj.insert("annotations".to_string(), ann);
        }
    }

    let response = if pending
        .original_input
        .get("codexMethod")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        build_codex_user_input_response_payload(&pending.original_input, &answers)?
    } else {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": updated_input,
        })
    };
    ps.send_control_response(&pending.request_id, response)
        .await
}

/// Resolve a pending control that originated from a Claudette MCP tool
/// (`ask_user` / `request_review`) by sending `answer` to the awaiting bridge
/// handler's oneshot. Mirrors the validate-before-remove discipline of the CLI
/// path, but there is no `persistent_session` to reply to — the agent is
/// suspended inside its MCP tool call.
async fn submit_mcp_answer(
    state: &AppState,
    session_id: &str,
    tool_use_id: &str,
    expected_tool: &str,
    answer: serde_json::Value,
) -> Result<(), String> {
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(session_id) {
            if let Some(p) = session.pending_permissions.get(tool_use_id)
                && p.tool_name != expected_tool
            {
                return Err(format!(
                    "Pending tool for {tool_use_id} is {}, not {expected_tool}",
                    p.tool_name
                ));
            }
            session.pending_permissions.remove(tool_use_id);
            session.reset_attention();
        }
    }
    let Some(pending) = state.take_mcp_reply(tool_use_id).await else {
        return Err(format!(
            "No pending MCP interaction for tool_use_id {tool_use_id}"
        ));
    };
    tracing::info!(
        target: "claudette::agent_mcp",
        tool_use_id = %tool_use_id,
        expected_tool = %expected_tool,
        "routing user response to MCP interactive prompt"
    );
    // Send failing means the agent's tool call already returned (e.g. the
    // session was torn down and the receiver dropped) — nothing left to do.
    let _ = pending.reply.send(answer);
    Ok(())
}

fn build_attention_response(
    pending: &PendingPermission,
    approved: bool,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    if is_codex_approval_tool_name(&pending.tool_name) {
        return build_codex_approval_response_payload(
            &pending.tool_name,
            &pending.original_input,
            approved,
        );
    }

    if approved {
        Ok(serde_json::json!({
            "behavior": "allow",
            "updatedInput": pending.original_input,
        }))
    } else {
        let feedback = reason.unwrap_or_else(|| "Plan denied. Please revise the approach.".into());
        let message = format!(
            "{feedback}\n\nRevise the plan to address this feedback, then call ExitPlanMode again to present the updated plan for approval. Do not begin implementation until the user approves the revised plan."
        );
        Ok(serde_json::json!({
            "behavior": "deny",
            "message": message,
        }))
    }
}

fn is_user_approval_tool(tool_name: &str) -> bool {
    tool_name == "ExitPlanMode" || is_codex_approval_tool_name(tool_name)
}

fn is_synthetic_codex_plan_approval(pending: &PendingPermission) -> bool {
    pending.tool_name == "ExitPlanMode"
        && pending
            .original_input
            .get("codexSyntheticPlan")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

/// Resolve a pending approval-style `can_use_tool` request.
/// `approved=true` → allow with the model's original input (the CLI's
/// `call()` will save the plan and emit the real tool_result for Claude plan
/// approvals, while Codex receives an app-server protocol response).
/// `approved=false` → deny with the given reason (or a sensible default).
async fn submit_approval_response(
    session_id: String,
    tool_use_id: String,
    approved: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // MCP-origin branch: a `request_review` verdict routes to the awaiting
    // oneshot. The existing plan card surfaces "Approve" or a feedback textarea;
    // that feedback path is semantically "suggest changes", so map
    // approved=false WITH a non-empty note to `suggest` and reserve `deny` for
    // an explicit deny-without-note (not reachable from today's card, but kept
    // for completeness so the agent can tell the two apart).
    if state.is_mcp_pending(&tool_use_id).await {
        let has_note = reason.as_deref().is_some_and(|r| !r.trim().is_empty());
        let verdict = match (approved, has_note) {
            (true, _) => "approve",
            (false, true) => "suggest",
            (false, false) => "deny",
        };
        return submit_mcp_answer(
            state.inner(),
            &session_id,
            &tool_use_id,
            "ExitPlanMode",
            serde_json::json!({ "verdict": verdict, "note": reason }),
        )
        .await;
    }

    // Same validate-before-remove pattern as submit_agent_answer — see that
    // function for the rationale.
    let (pending, ps) = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(&session_id).ok_or("Session not found")?;
        match session.pending_permissions.get(&tool_use_id) {
            None => {
                let pending_ids: Vec<String> =
                    session.pending_permissions.keys().cloned().collect();
                return Err(format!(
                    "No pending permission request for tool_use_id {tool_use_id} (pending: {pending_ids:?})"
                ));
            }
            Some(p) if !is_user_approval_tool(&p.tool_name) => {
                return Err(format!(
                    "Pending tool for {tool_use_id} is {}, not an approval request",
                    p.tool_name
                ));
            }
            _ => {}
        }
        let pending = session
            .pending_permissions
            .remove(&tool_use_id)
            .expect("checked above");
        session.reset_attention();
        let ps = if is_synthetic_codex_plan_approval(&pending) {
            None
        } else {
            Some(
                session
                    .persistent_session
                    .clone()
                    .ok_or("Agent session is not active")?,
            )
        };
        (pending, ps)
    };

    if is_synthetic_codex_plan_approval(&pending) {
        return Ok(());
    }

    let response = build_attention_response(&pending, approved, reason)?;
    ps.expect("non-synthetic approvals require a persistent session")
        .send_control_response(&pending.request_id, response)
        .await
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(reason, state),
    fields(chat_session_id = %session_id, tool_use_id = %tool_use_id, approved),
)]
pub async fn submit_plan_approval(
    session_id: String,
    tool_use_id: String,
    approved: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    submit_approval_response(session_id, tool_use_id, approved, reason, state).await
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(reason, state),
    fields(chat_session_id = %session_id, tool_use_id = %tool_use_id, approved),
)]
pub async fn submit_agent_approval(
    session_id: String,
    tool_use_id: String,
    approved: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    submit_approval_response(session_id, tool_use_id, approved, reason, state).await
}

/// Synchronously drain any pending permission requests from `session` and
/// snapshot the [`AgentSession`] needed to deny them. Designed to be
/// called while holding the agents write lock — does no async work itself.
///
/// Returns `None` when there is nothing to do (no pending entries) or when
/// there is no live `AgentSession` to receive the denies (entries are
/// dropped in that case, since nobody could read the response anyway).
pub(crate) fn drain_pending_permissions(
    session: &mut AgentSessionState,
) -> Option<(Arc<AgentSession>, Vec<PendingPermission>)> {
    if session.pending_permissions.is_empty() {
        return None;
    }
    let Some(ps) = session.persistent_session.clone() else {
        session.pending_permissions.clear();
        return None;
    };
    let drained: Vec<PendingPermission> = session
        .pending_permissions
        .drain()
        .map(|(_, p)| p)
        .collect();
    Some((ps, drained))
}

/// Send a deny `control_response` for each drained permission. Caller must
/// have already released the agents lock — this performs async I/O against
/// the CLI's stdin and would otherwise serialize all other agent-state ops.
pub(crate) async fn deny_drained_permissions(
    drained: Vec<PendingPermission>,
    ps: &AgentSession,
    reason: &str,
) {
    for pending in drained {
        let deny = build_attention_response(&pending, false, Some(reason.to_string()))
            .unwrap_or_else(|_| {
                serde_json::json!({
                    "behavior": "deny",
                    "message": reason,
                })
            });
        if let Err(e) = ps.send_control_response(&pending.request_id, deny).await {
            tracing::warn!(
                target: "claudette::chat",
                tool_name = %pending.tool_name,
                request_id = %pending.request_id,
                error = %e,
                "failed to deny pending tool on cleanup"
            );
        }
    }
}
