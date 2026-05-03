//! Server-side handlers for collaborative-session RPCs.
//!
//! Lives in its own file so the (already-large) `handler.rs` doesn't grow
//! further. Each function in this module is invoked from the dispatch arms
//! in `handle_request` and is structured to do its own auth checks (host
//! vs. non-host, joined-session membership) before mutating room state.

use std::sync::Arc;

use claudette::room::{ParticipantInfo, Vote};
use serde_json::json;

use crate::handler::ConnectionCtx;
use crate::ws::{ServerState, Writer, send_message};

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
    eprintln!(
        "[collab-trace] handle_join_session enter session={} pid={} collaborative={}",
        chat_session_id,
        ctx.participant_id.as_str(),
        ctx.collaborative
    );
    let room = if ctx.collaborative {
        state
            .rooms
            .get_or_create(chat_session_id, ctx.consensus_required)
            .await
    } else {
        match state.rooms.get(chat_session_id).await {
            Some(r) => r,
            None => {
                eprintln!(
                    "[collab-trace] handle_join_session reject (non-collab, no room) session={chat_session_id}"
                );
                return Err("Session is not collaborative".into());
            }
        }
    };
    eprintln!("[collab-trace] handle_join_session got room session={chat_session_id}");

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
        eprintln!(
            "[collab-trace] handle_join_session added participant pid={}",
            ctx.participant_id.as_str()
        );

        // Broadcast the join so existing participants update their roster.
        let snapshot = room.participant_list().await;
        eprintln!(
            "[collab-trace] handle_join_session publish participants-changed n={} subscribers={}",
            snapshot.len(),
            room.tx.receiver_count()
        );
        room.publish(json!({
            "event": "participants-changed",
            "payload": {
                "chat_session_id": chat_session_id,
                "participants": snapshot,
            },
        }));

        // Spawn the per-connection forwarder. Captures the writer so each
        // event published to the room reaches this client. On `Lagged`, we
        // emit a `resync-required` hint so the client can re-`join_session`
        // rather than silently miss events.
        let writer = Arc::clone(writer);
        let mut rx = room.subscribe();
        let chat_session_id_for_forwarder = chat_session_id.to_string();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(evt) => {
                        send_message(&writer, &evt.0).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = send_message(
                            &writer,
                            &json!({
                                "event": "resync-required",
                                "payload": {
                                    "chat_session_id": &chat_session_id_for_forwarder,
                                },
                            }),
                        )
                        .await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // Snapshot for late joiners: full chat history + current participants +
    // any open vote so the consensus card renders immediately.
    let db = claudette::db::Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let history = db
        .list_chat_messages_for_session(chat_session_id)
        .map_err(|e| e.to_string())?;
    let participants = room.participant_list().await;
    let consensus_required = *room.consensus_required.read().await;
    let turn_holder = room.current_turn_holder().await;

    Ok(json!({
        "history": history,
        "participants": participants,
        "consensus_required": consensus_required,
        "turn_holder": turn_holder.map(|p| p.0),
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

/// Forget every session this connection joined and broadcast the
/// resulting roster updates. Called from the WS connection-close path.
pub async fn drop_all_joined_sessions(state: &Arc<ServerState>, ctx: &ConnectionCtx) {
    let session_ids: Vec<String> = ctx.joined_sessions.lock().await.drain().collect();
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
