//! Collaborative-session "rooms".
//!
//! A `Room` is the single source of truth for one collaboratively-shared chat
//! session: it owns the live participant set, a broadcast channel that
//! fans out agent-stream events to every connected client (the local Tauri UI
//! plus any remote WebSocket clients), a turn lock so only one user can drive
//! the agent at a time, and any in-flight plan-consensus vote.
//!
//! Solo / 1:1 legacy remote sessions never touch this: the registry lazily
//! creates a room only when collaborative mode is enabled for a session, and
//! call sites fall back to the existing direct-emit path when no room exists.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, broadcast};

/// A stable per-pairing identity. Derived from the session token (server side)
/// or fixed to [`ParticipantId::HOST`] for the host's own local UI. Strings
/// are opaque to callers.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ParticipantId(pub String);

impl ParticipantId {
    /// Sentinel value used for the host process itself. Remote clients never
    /// receive this id from auth; only the local Tauri layer constructs it.
    pub const HOST: &'static str = "host";

    pub fn host() -> Self {
        Self(Self::HOST.to_string())
    }

    pub fn is_host(&self) -> bool {
        self.0 == Self::HOST
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParticipantInfo {
    pub id: ParticipantId,
    pub display_name: String,
    pub is_host: bool,
    /// Unix-millis timestamp of when the participant joined this room.
    pub joined_at: i64,
    /// When true, the server rejects this participant's `send_chat_message`
    /// and `vote_plan_approval` RPCs. Mute is per-room, not per-pairing.
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Vote {
    Approve,
    Deny { reason: String },
}

impl Vote {
    pub fn is_deny(&self) -> bool {
        matches!(self, Vote::Deny { .. })
    }
}

/// Live state for a single open ExitPlanMode consensus vote.
///
/// `required_voters` is snapshotted at vote-open time so late joiners are
/// observers, not unanticipated blockers. It is pruned on participant
/// disconnect so a ghosted voter doesn't deadlock the agent.
#[derive(Debug, Clone)]
pub struct PendingVote {
    pub tool_use_id: String,
    pub required_voters: HashSet<ParticipantId>,
    pub votes: HashMap<ParticipantId, Vote>,
}

impl PendingVote {
    pub fn new(tool_use_id: String, required_voters: HashSet<ParticipantId>) -> Self {
        Self {
            tool_use_id,
            required_voters,
            votes: HashMap::new(),
        }
    }
}

/// One broadcast envelope. The payload is already a fully-shaped JSON-RPC
/// event object (`{"event": "...", "payload": {...}}`) so subscribers can
/// forward it to their writer without re-shaping.
#[derive(Debug, Clone)]
pub struct RoomEvent(pub serde_json::Value);

/// Bounded broadcast capacity. Tuned for live-token streaming: large enough
/// that a normal client won't lag during a single turn, small enough that
/// memory cost is bounded if a client truly stalls.
const ROOM_BROADCAST_CAPACITY: usize = 256;

pub struct Room {
    pub chat_session_id: String,
    /// Lossy fan-out of events. Slow subscribers receive `RecvError::Lagged`
    /// and are expected to resync via `join_session`.
    pub tx: broadcast::Sender<RoomEvent>,
    pub participants: RwLock<HashMap<ParticipantId, ParticipantInfo>>,
    /// `true` means ExitPlanMode requires unanimous approval (with host veto)
    /// before the agent is allowed to leave plan mode. See
    /// [`crate::room`] module docs.
    pub consensus_required: RwLock<bool>,
    /// `Some(holder)` while a turn is in flight; new `send_chat_message`
    /// requests from any other participant must be rejected.
    pub turn_holder: Mutex<Option<ParticipantId>>,
    pub pending_vote: RwLock<Option<PendingVote>>,
}

impl Room {
    pub fn new(chat_session_id: String, consensus_required: bool) -> Arc<Self> {
        let (tx, _) = broadcast::channel(ROOM_BROADCAST_CAPACITY);
        Arc::new(Self {
            chat_session_id,
            tx,
            participants: RwLock::new(HashMap::new()),
            consensus_required: RwLock::new(consensus_required),
            turn_holder: Mutex::new(None),
            pending_vote: RwLock::new(None),
        })
    }

    /// Publish an event to every subscriber. A `SendError` (zero subscribers)
    /// is silently ignored — that just means nobody is listening *yet*; the
    /// event was still persisted upstream by the caller (DB writes happen
    /// outside the broadcast).
    pub fn publish(&self, event: serde_json::Value) {
        let _ = self.tx.send(RoomEvent(event));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RoomEvent> {
        self.tx.subscribe()
    }

    pub async fn add_participant(&self, info: ParticipantInfo) {
        self.participants
            .write()
            .await
            .insert(info.id.clone(), info);
    }

    pub async fn remove_participant(&self, id: &ParticipantId) -> Option<ParticipantInfo> {
        self.participants.write().await.remove(id)
    }

    pub async fn participant_list(&self) -> Vec<ParticipantInfo> {
        self.participants.read().await.values().cloned().collect()
    }

    pub async fn is_muted(&self, id: &ParticipantId) -> bool {
        self.participants
            .read()
            .await
            .get(id)
            .map(|p| p.muted)
            .unwrap_or(false)
    }

    pub async fn set_muted(&self, id: &ParticipantId, muted: bool) -> bool {
        let mut guard = self.participants.write().await;
        if let Some(p) = guard.get_mut(id) {
            p.muted = muted;
            true
        } else {
            false
        }
    }

    /// Attempt to acquire the turn for `participant`. Returns `Ok(())` if the
    /// caller now holds the turn, or `Err(current_holder)` if someone else
    /// already does. Hard reject — never queues.
    pub async fn try_acquire_turn(&self, participant: &ParticipantId) -> Result<(), ParticipantId> {
        let mut holder = self.turn_holder.lock().await;
        match holder.as_ref() {
            Some(current) if current != participant => Err(current.clone()),
            _ => {
                *holder = Some(participant.clone());
                Ok(())
            }
        }
    }

    pub async fn release_turn(&self) {
        *self.turn_holder.lock().await = None;
    }

    pub async fn current_turn_holder(&self) -> Option<ParticipantId> {
        self.turn_holder.lock().await.clone()
    }
}

/// Process-wide registry shared between the Tauri host and the embedded
/// `claudette-server`. Both sides hold the same `Arc<RoomRegistry>` so a
/// publish from either side reaches subscribers on the other.
#[derive(Default)]
pub struct RoomRegistry {
    rooms: RwLock<HashMap<String, Arc<Room>>>,
}

impl RoomRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Look up an existing room. Returns `None` for solo / 1:1 sessions.
    pub async fn get(&self, chat_session_id: &str) -> Option<Arc<Room>> {
        self.rooms.read().await.get(chat_session_id).cloned()
    }

    /// Get-or-create. Use when starting a collaborative share.
    pub async fn get_or_create(
        &self,
        chat_session_id: &str,
        consensus_required: bool,
    ) -> Arc<Room> {
        // Fast path: read-locked existence check.
        if let Some(room) = self.rooms.read().await.get(chat_session_id).cloned() {
            return room;
        }
        let mut guard = self.rooms.write().await;
        // Double-check under write lock to handle the racing-creators case.
        if let Some(room) = guard.get(chat_session_id).cloned() {
            return room;
        }
        let room = Room::new(chat_session_id.to_string(), consensus_required);
        guard.insert(chat_session_id.to_string(), room.clone());
        room
    }

    /// Tear down a room when its share ends. Subscribers will see their
    /// receivers close on next `recv()`.
    pub async fn remove(&self, chat_session_id: &str) -> Option<Arc<Room>> {
        self.rooms.write().await.remove(chat_session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pid(s: &str) -> ParticipantId {
        ParticipantId(s.to_string())
    }

    fn info(id: &str, host: bool) -> ParticipantInfo {
        ParticipantInfo {
            id: pid(id),
            display_name: id.to_string(),
            is_host: host,
            joined_at: 0,
            muted: false,
        }
    }

    #[tokio::test]
    async fn registry_get_or_create_is_idempotent() {
        let reg = RoomRegistry::new();
        let a = reg.get_or_create("s1", false).await;
        let b = reg.get_or_create("s1", true).await;
        // Same room — `consensus_required` flag from the second call is
        // ignored because the room already exists. Callers must mutate the
        // flag explicitly via `consensus_required.write()`.
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn publish_fans_out_to_all_subscribers() {
        let room = Room::new("s1".into(), false);
        let mut rx1 = room.subscribe();
        let mut rx2 = room.subscribe();
        room.publish(json!({"event": "hello"}));
        let e1 = rx1.recv().await.unwrap();
        let e2 = rx2.recv().await.unwrap();
        assert_eq!(e1.0, json!({"event": "hello"}));
        assert_eq!(e2.0, json!({"event": "hello"}));
    }

    #[tokio::test]
    async fn publish_with_zero_subscribers_does_not_panic() {
        let room = Room::new("s1".into(), false);
        room.publish(json!({"event": "into-the-void"}));
    }

    #[tokio::test]
    async fn turn_lock_rejects_concurrent_acquirers() {
        let room = Room::new("s1".into(), false);
        let alice = pid("alice");
        let bob = pid("bob");
        room.try_acquire_turn(&alice).await.unwrap();
        let err = room.try_acquire_turn(&bob).await.unwrap_err();
        assert_eq!(err, alice);
        // Same participant re-acquiring (e.g. retry of same prompt) is OK —
        // they already hold it.
        room.try_acquire_turn(&alice).await.unwrap();
        room.release_turn().await;
        // After release anyone can take it.
        room.try_acquire_turn(&bob).await.unwrap();
    }

    #[tokio::test]
    async fn participant_lifecycle() {
        let room = Room::new("s1".into(), false);
        room.add_participant(info("alice", false)).await;
        room.add_participant(info("bob", false)).await;
        assert_eq!(room.participant_list().await.len(), 2);
        assert!(!room.is_muted(&pid("alice")).await);
        assert!(room.set_muted(&pid("alice"), true).await);
        assert!(room.is_muted(&pid("alice")).await);
        // Muting a non-existent participant returns false rather than
        // silently inserting one.
        assert!(!room.set_muted(&pid("nobody"), true).await);
        assert!(room.remove_participant(&pid("alice")).await.is_some());
        assert!(room.remove_participant(&pid("alice")).await.is_none());
    }

    #[tokio::test]
    async fn pending_vote_carries_required_voters() {
        let mut required = HashSet::new();
        required.insert(pid("host"));
        required.insert(pid("alice"));
        let mut vote = PendingVote::new("tool-1".into(), required);
        vote.votes.insert(pid("host"), Vote::Approve);
        assert_eq!(vote.votes.len(), 1);
        assert_eq!(vote.required_voters.len(), 2);
    }
}
