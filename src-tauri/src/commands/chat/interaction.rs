use std::sync::Arc;

use tauri::State;

use claudette::agent::PersistentSession;

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
    record_agent_answer(
        &state,
        &session_id,
        &tool_use_id,
        &claudette::room::ParticipantId::host(),
        answers,
        annotations,
        true,
    )
    .await
}

pub async fn record_agent_answer(
    state: &AppState,
    session_id: &str,
    tool_use_id: &str,
    participant: &claudette::room::ParticipantId,
    answers: std::collections::HashMap<String, String>,
    annotations: Option<serde_json::Value>,
    broadcast_cast: bool,
) -> Result<(), String> {
    use std::sync::Arc;

    enum QuestionOutcome {
        WaitingForMore,
        Finalized {
            request_id: String,
            original_input: serde_json::Value,
            pending: Box<crate::state::PendingPermission>,
            annotations: Option<serde_json::Value>,
            ps: Arc<claudette::agent::PersistentSession>,
        },
    }

    // Validate everything BEFORE removing the pending entry: if the session
    // has been torn down or the entry maps to the wrong tool, the entry must
    // stay so the user (or the correct submit_* command) can still see it.
    let live_required_voters = if let Some(room) = state.rooms.get(session_id).await
        && *room.consensus_required.read().await
    {
        let participants = room.participants.read().await;
        let voters = participants
            .values()
            .filter(|p| !p.muted)
            .map(|p| p.id.clone())
            .collect::<std::collections::HashSet<_>>();
        if voters.is_empty() {
            None
        } else {
            Some(voters)
        }
    } else {
        None
    };

    let outcome = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(session_id).ok_or("Session not found")?;
        // 1. Persistent session must be alive — otherwise nobody is reading
        //    stdin and the response would be discarded.
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Agent session is not active")?;
        // 2. Tool kind must match — peek by reference.
        match session.pending_permissions.get(tool_use_id) {
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
        let pending_mut = session
            .pending_permissions
            .get_mut(tool_use_id)
            .expect("checked above");
        if pending_mut.required_voters.is_empty()
            && let Some(required_voters) = live_required_voters
        {
            pending_mut.required_voters = required_voters;
        }
        pending_mut.question_votes.insert(
            participant.clone(),
            claudette::room::QuestionVote {
                answers: answers.clone(),
            },
        );

        if !pending_mut.required_voters.is_empty()
            && !pending_mut
                .required_voters
                .iter()
                .all(|voter| pending_mut.question_votes.contains_key(voter))
        {
            QuestionOutcome::WaitingForMore
        } else {
            let pending = session
                .pending_permissions
                .remove(tool_use_id)
                .expect("checked above");
            session.reset_attention();
            QuestionOutcome::Finalized {
                request_id: pending.request_id.clone(),
                original_input: pending.original_input.clone(),
                pending: Box::new(pending),
                annotations,
                ps,
            }
        }
    };

    if let Some(room) = state.rooms.get(session_id).await {
        if broadcast_cast {
            room.publish(serde_json::json!({
                "event": "agent-question-answer-cast",
                "payload": {
                    "chat_session_id": session_id,
                    "tool_use_id": tool_use_id,
                    "participant_id": participant.as_str(),
                    "answers": &answers,
                },
            }));
        }
        if matches!(outcome, QuestionOutcome::Finalized { .. }) {
            room.publish(serde_json::json!({
                "event": "agent-question-resolved",
                "payload": {
                    "chat_session_id": session_id,
                    "tool_use_id": tool_use_id,
                },
            }));
        }
    }

    let QuestionOutcome::Finalized {
        request_id,
        original_input,
        pending,
        annotations,
        ps,
    } = outcome
    else {
        return Ok(());
    };
    let answers = aggregate_question_answers(state, session_id, pending.as_ref()).await;

    // Layer answers (and annotations, if any) onto the original input.
    let mut updated_input = original_input;
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
    ps.send_control_response(&request_id, response).await
}

async fn aggregate_question_answers(
    state: &AppState,
    session_id: &str,
    pending: &crate::state::PendingPermission,
) -> std::collections::HashMap<String, String> {
    if pending.question_votes.len() <= 1 {
        return pending
            .question_votes
            .values()
            .next()
            .map(|vote| vote.answers.clone())
            .unwrap_or_default();
    }

    let participants = if let Some(room) = state.rooms.get(session_id).await {
        room.participant_list()
            .await
            .into_iter()
            .map(|p| (p.id, p.display_name))
            .collect::<std::collections::HashMap<_, _>>()
    } else {
        std::collections::HashMap::new()
    };

    let mut by_question: std::collections::BTreeMap<String, Vec<(String, String)>> =
        std::collections::BTreeMap::new();
    for (participant, vote) in &pending.question_votes {
        let display = participants
            .get(participant)
            .cloned()
            .unwrap_or_else(|| participant.as_str().to_string());
        for (question, answer) in &vote.answers {
            by_question
                .entry(question.clone())
                .or_default()
                .push((display.clone(), answer.clone()));
        }
    }

    by_question
        .into_iter()
        .map(|(question, mut answers)| {
            answers.sort_by(|a, b| a.0.cmp(&b.0));
            let unanimous = answers
                .first()
                .map(|(_, first)| answers.iter().all(|(_, answer)| answer == first))
                .unwrap_or(false);
            let answer = if unanimous {
                answers
                    .first()
                    .map(|(_, answer)| answer.clone())
                    .unwrap_or_default()
            } else {
                answers
                    .into_iter()
                    .map(|(display, answer)| format!("{display}: {answer}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            (question, answer)
        })
        .collect()
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
        if !is_host
            && !pending_mut.required_voters.is_empty()
            && !pending_mut.required_voters.contains(participant)
        {
            return Ok(());
        }
        pending_mut.votes.insert(participant.clone(), vote.clone());

        let resolution = resolve_consensus(pending_mut, participant, is_host, &vote);

        match resolution {
            None => VoteOutcome::WaitingForMore,
            Some(final_vote) => {
                let pending = session
                    .pending_permissions
                    .remove(tool_use_id)
                    .expect("checked above");
                // Use the shared `reset_attention()` helper so this block stays
                // in sync with the other places that clear pending-permission
                // state (`submit_agent_answer`, `submit_plan_approval`, the
                // session-lifecycle teardown). Inline triple-assign would
                // drift if the helper grew new fields.
                session.reset_attention();
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

    let finalized = matches!(outcome, VoteOutcome::Finalized { .. });
    if let Some(room) = state.rooms.get(session_id).await {
        if finalized {
            *room.pending_vote.write().await = None;
        } else {
            let mut pending_vote = room.pending_vote.write().await;
            if let Some(pending_vote) = pending_vote.as_mut()
                && pending_vote.tool_use_id == tool_use_id
            {
                pending_vote.votes.insert(participant.clone(), vote.clone());
            }
        }
    }

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
    if !pending.required_voters.contains(voter) {
        return None;
    }
    evaluate_resolved_state(pending)
}

/// State-only resolution rule used when re-evaluating an open vote after
/// the participant set changes (no fresh "just cast"). Same shape as the
/// non-host branch of [`resolve_consensus`]: a non-host deny short-
/// circuits, otherwise unanimous approve resolves, otherwise wait.
///
/// Pulled out so the participant-pruning path can share the rule with
/// `resolve_consensus`.
fn evaluate_resolved_state(
    pending: &crate::state::PendingPermission,
) -> Option<claudette::room::Vote> {
    if let Some((_, vote)) = pending
        .votes
        .iter()
        .find(|(pid, v)| !pid.is_host() && pending.required_voters.contains(pid) && v.is_deny())
    {
        return Some(vote.clone());
    }
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

/// Re-evaluate every open consensus vote on `session_id` after the room's
/// participant set changed (someone joined, left, or was kicked/muted). For
/// each pending plan-permission with a non-empty `required_voters`:
///
/// 1. Drop any required voter who is no longer in `current_participants`,
///    along with their cast vote (treat the absentee as an *implicit
///    abstain* — neither approve nor deny). The host is exempt from
///    pruning since the host is always implicitly present from the
///    Tauri side.
/// 2. Re-evaluate via [`evaluate_resolved_state`]. If the round now
///    resolves (remaining required voters all approved, or a non-host
///    deny is still in the pruned vote set), finalize: send the
///    `control_response` and broadcast `plan-vote-resolved`.
///
/// "Implicit abstain" is the conservative default: leaving the vote
/// open until one of the remaining voters acts, rather than auto-
/// approving or auto-denying on a participant's behalf. Without this
/// pruning a single disconnect could deadlock the agent indefinitely.
pub async fn prune_consensus_voters_for_session(
    state: &AppState,
    session_id: &str,
    current_participants: &std::collections::HashSet<claudette::room::ParticipantId>,
) -> Result<(), String> {
    use std::sync::Arc;

    struct Finalize {
        request_id: String,
        tool_use_id: String,
        ps: Arc<PersistentSession>,
        final_vote: claudette::room::Vote,
        original_input: serde_json::Value,
    }

    // Pass 1: prune absentees and collect any pending entries that have
    // newly resolved as a result.
    let mut finalize_list: Vec<Finalize> = Vec::new();
    {
        let mut agents = state.agents.write().await;
        let Some(session) = agents.get_mut(session_id) else {
            return Ok(());
        };
        let Some(ps) = session.persistent_session.clone() else {
            return Ok(());
        };
        let tool_use_ids: Vec<String> = session.pending_permissions.keys().cloned().collect();
        let mut any_finalized = false;
        for tool_use_id in tool_use_ids {
            let Some(pending_mut) = session.pending_permissions.get_mut(&tool_use_id) else {
                continue;
            };
            // Only consensus-required entries care about participant changes.
            if pending_mut.required_voters.is_empty() {
                continue;
            }
            pending_mut
                .required_voters
                .retain(|pid| pid.is_host() || current_participants.contains(pid));
            pending_mut
                .votes
                .retain(|pid, _| pid.is_host() || current_participants.contains(pid));

            if let Some(final_vote) = evaluate_resolved_state(pending_mut) {
                let pending = session
                    .pending_permissions
                    .remove(&tool_use_id)
                    .expect("checked above");
                finalize_list.push(Finalize {
                    request_id: pending.request_id,
                    tool_use_id,
                    ps: ps.clone(),
                    final_vote,
                    original_input: pending.original_input,
                });
                any_finalized = true;
            }
        }
        if any_finalized {
            session.reset_attention();
        }
    }

    // Pass 2: deliver control responses and broadcast outcomes. Done
    // outside the agents write lock so the broadcast doesn't block other
    // RPCs and the control-response send can do its own awaits.
    for f in finalize_list {
        let (response, kind, reason) = match &f.final_vote {
            claudette::room::Vote::Approve => (
                serde_json::json!({
                    "behavior": "allow",
                    "updatedInput": &f.original_input,
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
        if let Some(room) = state.rooms.get(session_id).await {
            room.publish(serde_json::json!({
                "event": "plan-vote-resolved",
                "payload": {
                    "chat_session_id": session_id,
                    "tool_use_id": f.tool_use_id,
                    "outcome": kind,
                    "reason": reason,
                },
            }));
        }
        if let Err(e) = f.ps.send_control_response(&f.request_id, response).await {
            eprintln!(
                "[collab] prune resolver: send_control_response failed for {}: {e}",
                f.tool_use_id
            );
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::{evaluate_resolved_state, resolve_consensus};
    use crate::state::PendingPermission;

    fn pid(id: &str) -> claudette::room::ParticipantId {
        claudette::room::ParticipantId(id.to_string())
    }

    fn pending(required: &[&str]) -> PendingPermission {
        PendingPermission {
            request_id: "request-1".to_string(),
            tool_name: "ExitPlanMode".to_string(),
            original_input: serde_json::json!({}),
            required_voters: required.iter().map(|id| pid(id)).collect::<HashSet<_>>(),
            votes: HashMap::new(),
            question_votes: HashMap::new(),
        }
    }

    #[test]
    fn consensus_ignores_non_required_voter_denies() {
        let mut pending = pending(&["alice"]);
        pending.votes.insert(
            pid("observer"),
            claudette::room::Vote::Deny {
                reason: "nope".to_string(),
            },
        );

        assert_eq!(evaluate_resolved_state(&pending), None);
        assert_eq!(
            resolve_consensus(
                &pending,
                &pid("observer"),
                false,
                &claudette::room::Vote::Deny {
                    reason: "nope".to_string(),
                },
            ),
            None,
        );
    }

    #[test]
    fn consensus_resolves_when_required_voters_approve() {
        let mut pending = pending(&["alice", "bob"]);
        pending
            .votes
            .insert(pid("alice"), claudette::room::Vote::Approve);
        pending
            .votes
            .insert(pid("bob"), claudette::room::Vote::Approve);

        assert_eq!(
            evaluate_resolved_state(&pending),
            Some(claudette::room::Vote::Approve),
        );
    }
}
