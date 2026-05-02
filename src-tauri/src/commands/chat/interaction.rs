use std::sync::Arc;

use tauri::State;

use claudette::agent::PersistentSession;

use crate::state::{AgentSessionState, AppState, PendingPermission};

#[tauri::command]
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
        session.needs_attention = false;
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
pub async fn submit_agent_answer(
    session_id: String,
    tool_use_id: String,
    answers: std::collections::HashMap<String, String>,
    annotations: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
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
        session.needs_attention = false;
        session.attention_kind = None;
        session.attention_notification_sent = false;
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

    let response = serde_json::json!({
        "behavior": "allow",
        "updatedInput": updated_input,
    });
    ps.send_control_response(&pending.request_id, response)
        .await
}

/// Resolve a pending ExitPlanMode `can_use_tool` request.
/// `approved=true` → allow with the model's original input (the CLI's
/// `call()` will save the plan and emit the real tool_result).
/// `approved=false` → deny with the given reason (or a sensible default).
///
/// In collaborative + consensus mode, this records the host's vote and may
/// finalize the outcome immediately (host veto: an approve forces approval,
/// a deny forces denial), or wait for remaining required voters.
#[tauri::command]
pub async fn submit_plan_approval(
    session_id: String,
    tool_use_id: String,
    approved: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    record_plan_vote(
        &state,
        &session_id,
        &tool_use_id,
        &claudette::room::ParticipantId::host(),
        true, // is_host
        if approved {
            claudette::room::Vote::Approve
        } else {
            claudette::room::Vote::Deny {
                reason: reason.unwrap_or_else(|| "Plan denied. Please revise the approach.".into()),
            }
        },
        true, // broadcast cast — fresh host-originated vote
    )
    .await
}

/// Record one participant's vote on an open plan-consensus and finalize the
/// outcome if the unanimous-with-host-veto rule is now satisfied. Shared
/// between the local Tauri command and the host-side resolver task that
/// consumes `plan-vote-cast` events forwarded from remote participants.
///
/// `broadcast_cast` controls whether this call broadcasts the
/// `plan-vote-cast` event itself. `true` for fresh host-originated votes;
/// `false` when called from the resolver task on an event that the remote
/// server already broadcast (preventing double-emission).
pub async fn record_plan_vote(
    state: &AppState,
    session_id: &str,
    tool_use_id: &str,
    participant: &claudette::room::ParticipantId,
    is_host: bool,
    vote: claudette::room::Vote,
    broadcast_cast: bool,
) -> Result<(), String> {
    use std::sync::Arc;
    enum VoteOutcome {
        WaitingForMore,
        Finalized {
            request_id: String,
            response: serde_json::Value,
            ps: Arc<claudette::agent::PersistentSession>,
            outcome_kind: &'static str,
            outcome_reason: Option<String>,
        },
    }

    let outcome = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(session_id).ok_or("Session not found")?;
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Agent session is not active")?;
        match session.pending_permissions.get(tool_use_id) {
            None => {
                let pending_ids: Vec<String> =
                    session.pending_permissions.keys().cloned().collect();
                return Err(format!(
                    "No pending permission request for tool_use_id {tool_use_id} (pending: {pending_ids:?})"
                ));
            }
            Some(p) if p.tool_name != "ExitPlanMode" => {
                return Err(format!(
                    "Pending tool for {tool_use_id} is {}, not ExitPlanMode",
                    p.tool_name
                ));
            }
            _ => {}
        }

        let pending_mut = session
            .pending_permissions
            .get_mut(tool_use_id)
            .expect("checked above");
        pending_mut.votes.insert(participant.clone(), vote.clone());

        let resolution = resolve_consensus(pending_mut, participant, is_host, &vote);

        match resolution {
            None => VoteOutcome::WaitingForMore,
            Some(final_vote) => {
                let pending = session
                    .pending_permissions
                    .remove(tool_use_id)
                    .expect("checked above");
                session.needs_attention = false;
                session.attention_kind = None;
                session.attention_notification_sent = false;
                let (response, kind, reason) = match &final_vote {
                    claudette::room::Vote::Approve => (
                        serde_json::json!({
                            "behavior": "allow",
                            "updatedInput": &pending.original_input,
                        }),
                        "approve",
                        None,
                    ),
                    claudette::room::Vote::Deny { reason } => {
                        let message = format!(
                            "{reason}\n\nRevise the plan to address this feedback, then call ExitPlanMode again to present the updated plan for approval. Do not begin implementation until the user approves the revised plan."
                        );
                        (
                            serde_json::json!({
                                "behavior": "deny",
                                "message": message,
                            }),
                            "deny",
                            Some(reason.clone()),
                        )
                    }
                };
                VoteOutcome::Finalized {
                    request_id: pending.request_id,
                    response,
                    ps,
                    outcome_kind: kind,
                    outcome_reason: reason,
                }
            }
        }
    };

    if broadcast_cast && let Some(room) = state.rooms.get(session_id).await {
        room.publish(serde_json::json!({
            "event": "plan-vote-cast",
            "payload": {
                "chat_session_id": session_id,
                "tool_use_id": tool_use_id,
                "participant_id": participant.as_str(),
                "vote": &vote,
            },
        }));
    }

    match outcome {
        VoteOutcome::WaitingForMore => Ok(()),
        VoteOutcome::Finalized {
            request_id,
            response,
            ps,
            outcome_kind,
            outcome_reason,
        } => {
            if let Some(room) = state.rooms.get(session_id).await {
                room.publish(serde_json::json!({
                    "event": "plan-vote-resolved",
                    "payload": {
                        "chat_session_id": session_id,
                        "tool_use_id": tool_use_id,
                        "outcome": outcome_kind,
                        "reason": outcome_reason,
                    },
                }));
            }
            ps.send_control_response(&request_id, response).await
        }
    }
}

/// Pure resolution rule: given the current pending state and the just-cast
/// vote, return `Some(final_vote)` if the round resolves now, or `None` if
/// it still needs more input. Extracted as a free function for unit tests.
///
/// Rules: host vote is decisive (host veto). Non-host: any deny short-circuits
/// to deny with that user's critique; approve resolves only when every required
/// voter has voted approve. Empty `required_voters` (non-consensus path)
/// always resolves to the submitted vote.
fn resolve_consensus(
    pending: &crate::state::PendingPermission,
    voter: &claudette::room::ParticipantId,
    voter_is_host: bool,
    just_cast: &claudette::room::Vote,
) -> Option<claudette::room::Vote> {
    if pending.required_voters.is_empty() {
        return Some(just_cast.clone());
    }
    if voter_is_host {
        return Some(just_cast.clone());
    }
    if let Some((_, vote)) = pending
        .votes
        .iter()
        .find(|(pid, v)| !pid.is_host() && v.is_deny())
    {
        return Some(vote.clone());
    }
    let _ = voter;
    let all_approved = pending.required_voters.iter().all(|pid| {
        pending
            .votes
            .get(pid)
            .map(|v| matches!(v, claudette::room::Vote::Approve))
            .unwrap_or(false)
    });
    if all_approved {
        Some(claudette::room::Vote::Approve)
    } else {
        None
    }
}

/// Synchronously drain any pending permission requests from `session` and
/// snapshot the [`PersistentSession`] needed to deny them. Designed to be
/// called while holding the agents write lock — does no async work itself.
///
/// Returns `None` when there is nothing to do (no pending entries) or when
/// there is no live `PersistentSession` to receive the denies (entries are
/// dropped in that case, since nobody could read the response anyway).
pub(crate) fn drain_pending_permissions(
    session: &mut AgentSessionState,
) -> Option<(Arc<PersistentSession>, Vec<PendingPermission>)> {
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
    ps: &PersistentSession,
    reason: &str,
) {
    for pending in drained {
        let deny = serde_json::json!({
            "behavior": "deny",
            "message": reason,
        });
        if let Err(e) = ps.send_control_response(&pending.request_id, deny).await {
            eprintln!(
                "[chat] Failed to deny pending {} on cleanup: {e}",
                pending.tool_name
            );
        }
    }
}
