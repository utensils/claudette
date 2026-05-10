//! Server-side handlers for collaborative-session RPCs.
//!
//! Lives in its own file so the (already-large) `handler.rs` doesn't grow
//! further. Each function in this module is invoked from the dispatch arms
//! in `handle_request` and is structured to do its own auth checks (host
//! vs. non-host, joined-session membership) before mutating room state.

use std::sync::Arc;

use claudette::room::{ParticipantId, ParticipantInfo, PendingVote, Vote};
use serde_json::json;

use crate::handler::ConnectionCtx;
use crate::ws::{ServerState, Writer, try_send_message};

/// Register a participant against a room, spawn their per-connection event
/// forwarder, and return a snapshot of the room's current state so the
/// client can render without lag.
///
/// Idempotent: re-joining the same session does not double-add the
/// participant or duplicate the forwarder. The forwarder ends naturally
/// when the underlying broadcast channel closes (room dropped from the
/// registry on `stop_collaborative_share`).
pub async fn handle_join_session(
    state: &Arc<ServerState>,
    writer: &Arc<Writer>,
    ctx: &ConnectionCtx,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    // When the parent share is collaborative, we lazily create a room on
    // first join. That removes the host's per-session "Enable collab"
    // step — once they share a workspace in collab mode, every chat
    // session in scope automatically gets a multi-user room when the
    // first remote arrives.
    if !ctx.collaborative {
        return Err("Session is not collaborative".into());
    }
    let room = state
        .rooms
        .get_or_create(chat_session_id, ctx.consensus_required)
        .await;

    // Mark this connection as joined first; idempotency below depends on it.
    let already_joined = {
        let mut joined = ctx.joined_sessions.lock().await;
        !joined.insert(chat_session_id.to_string())
    };

    if !already_joined {
        let info = ParticipantInfo {
            id: ctx.participant_id.clone(),
            display_name: ctx.display_name.clone(),
            is_host: ctx.is_host,
            joined_at: now_unix_ms(),
            muted: false,
        };
        room.add_participant(info.clone()).await;

        // Broadcast the join so existing participants update their roster.
        room.publish(json!({
            "event": "participants-changed",
            "payload": {
                "chat_session_id": chat_session_id,
                "participants": room.participant_list().await,
            },
        }));

        // Spawn the per-connection forwarder. Captures the writer so each
        // event published to the room reaches this client. On `Lagged`, we
        // emit a `resync-required` hint so the client can re-`join_session`
        // rather than silently miss events.
        let writer = Arc::clone(writer);
        let mut rx = room.subscribe();
        let chat_session_id_for_forwarder = chat_session_id.to_string();
        let share_id = ctx.share_id.clone();
        let config = Arc::clone(&state.config);
        let forwarder = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(evt) => {
                        let share_still_exists = {
                            let cfg = config.lock().await;
                            cfg.shares.iter().any(|share| share.id == share_id)
                        };
                        if !share_still_exists {
                            break;
                        }
                        if try_send_message(&writer, &evt.0).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if try_send_message(
                            &writer,
                            &json!({
                                "event": "resync-required",
                                "payload": {
                                    "chat_session_id": &chat_session_id_for_forwarder,
                                },
                            }),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        ctx.room_forwarders
            .lock()
            .await
            .insert(chat_session_id.to_string(), forwarder);
    }

    // Snapshot for late joiners: current participants, turn metadata, and
    // any open vote/question so consensus UI renders immediately. Chat
    // history is intentionally not included here; clients fetch it through
    // the existing history RPC to keep join_session lightweight.
    let participants = room.participant_list().await;
    let consensus_required = *room.consensus_required.read().await;
    let turn_holder = room.current_turn_holder().await;
    let turn_started_at_ms = *room.turn_started_at_ms.lock().await;
    let turn_settings = room.turn_settings.read().await.clone();
    let pending_vote = state.rooms.pending_vote_snapshot(chat_session_id).await;
    let pending_question = state.rooms.pending_question_snapshot(chat_session_id).await;

    Ok(json!({
        "participants": participants,
        "consensus_required": consensus_required,
        "turn_holder": turn_holder.map(|p| p.0),
        "turn_started_at_ms": turn_started_at_ms,
        "turn_settings": turn_settings,
        "pending_vote": pending_vote,
        "pending_question": pending_question,
    }))
}

pub async fn handle_leave_session(
    state: &Arc<ServerState>,
    ctx: &ConnectionCtx,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    let room = match state.rooms.get(chat_session_id).await {
        Some(r) => r,
        None => return Ok(json!(null)),
    };
    let removed = ctx.joined_sessions.lock().await.remove(chat_session_id);
    if removed {
        if let Some(handle) = ctx.room_forwarders.lock().await.remove(chat_session_id) {
            handle.abort();
        }
        room.remove_participant(&ctx.participant_id).await;
        room.publish(json!({
            "event": "participants-changed",
            "payload": {
                "chat_session_id": chat_session_id,
                "participants": room.participant_list().await,
            },
        }));
    }
    Ok(json!(null))
}

/// Record a remote participant's vote on an open ExitPlanMode consensus
/// round. Forwards into the same resolver the local Tauri side uses, but
/// we cannot call that directly across the process boundary — instead the
/// server publishes a `plan-vote-cast` event whose payload is consumed by
/// the host-side resolver task spawned in `start_collaborative_share`.
///
/// The host-side resolver is the *single* place where `send_control_response`
/// ever fires for ExitPlanMode in collab mode, so server-side voters never
/// race the host on the CLI control channel.
pub async fn handle_vote_plan_approval(
    state: &Arc<ServerState>,
    ctx: &ConnectionCtx,
    chat_session_id: &str,
    tool_use_id: &str,
    approved: bool,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    if !ctx.has_joined(chat_session_id).await {
        return Err("Not joined to this session".into());
    }
    let room = state
        .rooms
        .get(chat_session_id)
        .await
        .ok_or("Session is not collaborative")?;
    if room.is_muted(&ctx.participant_id).await {
        return Err("Muted participants cannot vote".into());
    }
    let vote = if approved {
        Vote::Approve
    } else {
        Vote::Deny {
            reason: reason.unwrap_or_else(|| "Denied without reason".into()),
        }
    };
    {
        let mut pending = room.pending_vote.write().await;
        record_plan_vote(&mut pending, &ctx.participant_id, tool_use_id, vote.clone())?;
    }
    room.publish(json!({
        "event": "plan-vote-cast",
        "payload": {
            "chat_session_id": chat_session_id,
            "tool_use_id": tool_use_id,
            "participant_id": ctx.participant_id.as_str(),
            "vote": &vote,
        },
    }));
    Ok(json!(null))
}

fn record_plan_vote(
    pending: &mut Option<PendingVote>,
    participant_id: &ParticipantId,
    tool_use_id: &str,
    vote: Vote,
) -> Result<(), String> {
    let Some(pending) = pending.as_mut() else {
        return Err("No pending plan approval vote".into());
    };
    if pending.tool_use_id != tool_use_id {
        return Err("Stale plan approval vote".into());
    }
    if !pending.required_voters.contains(participant_id) {
        return Err("Participant is not required for this vote".into());
    }
    pending.votes.insert(participant_id.clone(), vote);
    Ok(())
}

pub async fn handle_submit_agent_answer(
    state: &Arc<ServerState>,
    ctx: &ConnectionCtx,
    chat_session_id: &str,
    tool_use_id: &str,
    answers: std::collections::HashMap<String, String>,
    annotations: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !ctx.has_joined(chat_session_id).await {
        return Err("Not joined to this session".into());
    }
    let room = state
        .rooms
        .get(chat_session_id)
        .await
        .ok_or("Session is not collaborative")?;
    if room.is_muted(&ctx.participant_id).await {
        return Err("Muted participants cannot answer questions".into());
    }
    room.publish(json!({
        "event": "agent-answer-submitted",
        "payload": {
            "chat_session_id": chat_session_id,
            "tool_use_id": tool_use_id,
            "participant_id": ctx.participant_id.as_str(),
            "answers": answers,
            "annotations": annotations,
        },
    }));
    Ok(json!(null))
}

/// Forget every session this connection joined and broadcast the
/// resulting roster updates. Called from the WS connection-close path.
pub async fn drop_all_joined_sessions(state: &Arc<ServerState>, ctx: &ConnectionCtx) {
    let session_ids: Vec<String> = ctx.joined_sessions.lock().await.drain().collect();
    let forwarders: Vec<tokio::task::JoinHandle<()>> = ctx
        .room_forwarders
        .lock()
        .await
        .drain()
        .map(|(_, h)| h)
        .collect();
    for handle in forwarders {
        handle.abort();
    }
    for session_id in session_ids {
        let Some(room) = state.rooms.get(&session_id).await else {
            continue;
        };
        room.remove_participant(&ctx.participant_id).await;
        room.publish(json!({
            "event": "participants-changed",
            "payload": {
                "chat_session_id": &session_id,
                "participants": room.participant_list().await,
            },
        }));
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use claudette::room::{ParticipantId, PendingVote, Vote};

    use super::record_plan_vote;

    fn pending_vote(required: &[&str]) -> Option<PendingVote> {
        Some(PendingVote::new(
            "tool-1".to_string(),
            required
                .iter()
                .map(|id| ParticipantId((*id).to_string()))
                .collect::<HashSet<_>>(),
            serde_json::json!({}),
        ))
    }

    #[test]
    fn record_plan_vote_rejects_late_joiner() {
        let mut pending = pending_vote(&["host", "guest-a"]);
        let late_joiner = ParticipantId("guest-b".to_string());

        let err = record_plan_vote(&mut pending, &late_joiner, "tool-1", Vote::Approve)
            .expect_err("late joiners are observers");

        assert_eq!(err, "Participant is not required for this vote");
        assert!(
            !pending
                .as_ref()
                .expect("pending vote")
                .votes
                .contains_key(&late_joiner)
        );
    }

    #[test]
    fn record_plan_vote_rejects_stale_tool_use_id() {
        let voter = ParticipantId("guest-a".to_string());
        let mut pending = pending_vote(&["guest-a"]);

        let err = record_plan_vote(&mut pending, &voter, "tool-2", Vote::Approve)
            .expect_err("stale tool id must be rejected");

        assert_eq!(err, "Stale plan approval vote");
        assert!(
            !pending
                .as_ref()
                .expect("pending vote")
                .votes
                .contains_key(&voter)
        );
    }

    #[test]
    fn record_plan_vote_records_required_voter() {
        let voter = ParticipantId("guest-a".to_string());
        let mut pending = pending_vote(&["guest-a"]);

        record_plan_vote(&mut pending, &voter, "tool-1", Vote::Approve)
            .expect("required voter can vote");

        assert_eq!(
            pending.as_ref().expect("pending vote").votes.get(&voter),
            Some(&Vote::Approve)
        );
    }
}
