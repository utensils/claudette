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
use std::future::Future;
use std::pin::Pin;
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionVote {
    pub answers: HashMap<String, String>,
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
    pub original_input: serde_json::Value,
}

impl PendingVote {
    pub fn new(
        tool_use_id: String,
        required_voters: HashSet<ParticipantId>,
        original_input: serde_json::Value,
    ) -> Self {
        Self {
            tool_use_id,
            required_voters,
            votes: HashMap::new(),
            original_input,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingVoteSnapshot {
    pub tool_use_id: String,
    pub required_voters: Vec<ParticipantInfo>,
    pub votes: HashMap<String, Vote>,
    pub input: serde_json::Value,
    pub plan_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingQuestionSnapshot {
    pub tool_use_id: String,
    pub required_voters: Vec<ParticipantInfo>,
    pub votes: HashMap<String, QuestionVote>,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnSettingsSnapshot {
    pub model: Option<String>,
    pub plan_mode: bool,
}

type PendingVoteSnapshotFuture =
    Pin<Box<dyn Future<Output = Option<PendingVoteSnapshot>> + Send + 'static>>;
type PendingVoteSnapshotProvider =
    Box<dyn Fn(String) -> PendingVoteSnapshotFuture + Send + Sync + 'static>;
type PendingQuestionSnapshotFuture =
    Pin<Box<dyn Future<Output = Option<PendingQuestionSnapshot>> + Send + 'static>>;
type PendingQuestionSnapshotProvider =
    Box<dyn Fn(String) -> PendingQuestionSnapshotFuture + Send + Sync + 'static>;

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
    pub turn_started_at_ms: Mutex<Option<i64>>,
    pub turn_settings: RwLock<Option<TurnSettingsSnapshot>>,
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
            turn_started_at_ms: Mutex::new(None),
            turn_settings: RwLock::new(None),
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
        *self.turn_started_at_ms.lock().await = None;
        *self.turn_settings.write().await = None;
    }

    pub async fn current_turn_holder(&self) -> Option<ParticipantId> {
        self.turn_holder.lock().await.clone()
    }

    pub async fn pending_vote_snapshot(&self) -> Option<PendingVoteSnapshot> {
        let pending = self.pending_vote.read().await.clone()?;
        let participants = self.participants.read().await;
        let required_voters = pending
            .required_voters
            .iter()
            .filter_map(|id| participants.get(id).cloned())
            .collect();
        let votes = pending
            .votes
            .into_iter()
            .map(|(id, vote)| (id.0, vote))
            .collect();

        Some(PendingVoteSnapshot {
            tool_use_id: pending.tool_use_id,
            required_voters,
            votes,
            input: pending.original_input,
            plan_file_path: None,
        })
    }
}

/// Synchronous callback fired exactly once per newly-created room, before
/// the room becomes visible to any other caller. The Tauri host installs
/// this so it can capture a `broadcast::Receiver` (and spawn the local
/// event-mirror / vote-resolver tasks) *before* any handler — including
/// `handle_join_session` on the server side — publishes into the room.
///
/// Without this, the host would miss the very first `participants-changed`
/// event, because `tokio::sync::broadcast` does not buffer for late
/// subscribers.
type OnCreateHook = Box<dyn Fn(Arc<Room>) + Send + Sync>;

/// Process-wide registry shared between the Tauri host and the embedded
/// `claudette-server`. Both sides hold the same `Arc<RoomRegistry>` so a
/// publish from either side reaches subscribers on the other.
#[derive(Default)]
pub struct RoomRegistry {
    rooms: RwLock<HashMap<String, Arc<Room>>>,
    /// Optional hook invoked synchronously during `get_or_create` whenever a
    /// brand-new room is constructed. See [`OnCreateHook`] for the rationale.
    on_create: std::sync::Mutex<Option<OnCreateHook>>,
    pending_vote_snapshot_provider: std::sync::Mutex<Option<PendingVoteSnapshotProvider>>,
    pending_question_snapshot_provider: std::sync::Mutex<Option<PendingQuestionSnapshotProvider>>,
}

impl RoomRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Install the creation hook. The callback is fired with the new
    /// `Arc<Room>` before the room is published into the registry's map,
    /// so any `subscribe()` call inside the callback is guaranteed to
    /// observe every subsequent publish. There is at most one hook —
    /// later calls replace the previous one.
    pub fn set_on_create<F>(&self, callback: F)
    where
        F: Fn(Arc<Room>) + Send + Sync + 'static,
    {
        // `std::sync::Mutex` here (not tokio): the hook is set once at
        // startup and read on the (sync) creation path. We never await
        // while holding it.
        if let Ok(mut guard) = self.on_create.lock() {
            *guard = Some(Box::new(callback));
        }
    }

    pub fn set_pending_vote_snapshot_provider<F, Fut>(&self, callback: F)
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<PendingVoteSnapshot>> + Send + 'static,
    {
        if let Ok(mut guard) = self.pending_vote_snapshot_provider.lock() {
            *guard = Some(Box::new(move |session_id| Box::pin(callback(session_id))));
        }
    }

    pub fn set_pending_question_snapshot_provider<F, Fut>(&self, callback: F)
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Option<PendingQuestionSnapshot>> + Send + 'static,
    {
        if let Ok(mut guard) = self.pending_question_snapshot_provider.lock() {
            *guard = Some(Box::new(move |session_id| Box::pin(callback(session_id))));
        }
    }

    pub async fn pending_vote_snapshot(
        &self,
        chat_session_id: &str,
    ) -> Option<PendingVoteSnapshot> {
        if let Some(room) = self.get(chat_session_id).await
            && let Some(snapshot) = room.pending_vote_snapshot().await
        {
            return Some(snapshot);
        }

        let provider_future = {
            let guard = self.pending_vote_snapshot_provider.lock().ok()?;
            guard
                .as_ref()
                .map(|provider| provider(chat_session_id.to_string()))
        }?;
        provider_future.await
    }

    pub async fn pending_question_snapshot(
        &self,
        chat_session_id: &str,
    ) -> Option<PendingQuestionSnapshot> {
        let provider_future = {
            let guard = self.pending_question_snapshot_provider.lock().ok()?;
            guard
                .as_ref()
                .map(|provider| provider(chat_session_id.to_string()))
        }?;
        provider_future.await
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
        // Fire the creation hook *before* publishing into the map. This is
        // load-bearing: callers (e.g. the server's `handle_join_session`)
        // call `room.publish(...)` shortly after `get_or_create` returns,
        // and `tokio::sync::broadcast` does not deliver historical events
        // to subscribers attached after a publish. By calling the hook
        // here — synchronously, while we still hold the only `Arc<Room>`
        // outside the function — we guarantee any subscribers it spawns
        // see every subsequent event from turn one.
        if let Ok(hook) = self.on_create.lock()
            && let Some(cb) = hook.as_ref()
        {
            cb(room.clone());
        }
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
    async fn on_create_hook_subscribes_before_first_publish() {
        // Regression test for the publish-before-subscribe race: a hook
        // installed on the registry must run synchronously when a brand-new
        // room is created, *before* any caller can publish into it. Without
        // this guarantee the host UI loses the very first
        // `participants-changed` event of every collaborative session.
        let reg = RoomRegistry::new();
        let captured: std::sync::Arc<
            std::sync::Mutex<Option<tokio::sync::broadcast::Receiver<RoomEvent>>>,
        > = std::sync::Arc::new(std::sync::Mutex::new(None));
        let captured_clone = captured.clone();
        reg.set_on_create(move |room| {
            // Synchronous capture mirrors what the Tauri host does in
            // `attach_host_room_subscribers`.
            let rx = room.subscribe();
            *captured_clone.lock().unwrap() = Some(rx);
        });

        let room = reg.get_or_create("s1", false).await;
        // Simulate the publish that `handle_join_session` does immediately
        // after `get_or_create` returns.
        room.publish(json!({"event": "participants-changed"}));

        let mut rx = captured
            .lock()
            .unwrap()
            .take()
            .expect("hook should have run");
        let evt = rx
            .recv()
            .await
            .expect("first publish must reach hook subscriber");
        assert_eq!(evt.0, json!({"event": "participants-changed"}));

        // Hook fires only on creation, not on subsequent get_or_creates.
        let captured2: std::sync::Arc<std::sync::Mutex<u32>> =
            std::sync::Arc::new(std::sync::Mutex::new(0));
        let counter = captured2.clone();
        reg.set_on_create(move |_| {
            *counter.lock().unwrap() += 1;
        });
        let _ = reg.get_or_create("s1", false).await; // existing → no fire
        let _ = reg.get_or_create("s2", false).await; // new → fires once
        assert_eq!(*captured2.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn pending_vote_carries_required_voters() {
        let mut required = HashSet::new();
        required.insert(pid("host"));
        required.insert(pid("alice"));
        let mut vote = PendingVote::new("tool-1".into(), required, serde_json::json!({}));
        vote.votes.insert(pid("host"), Vote::Approve);
        assert_eq!(vote.votes.len(), 1);
        assert_eq!(vote.required_voters.len(), 2);
    }

    #[tokio::test]
    async fn pending_vote_snapshot_uses_participant_details() {
        let room = Room::new("s1".into(), true);
        room.add_participant(info("host", true)).await;
        room.add_participant(info("alice", false)).await;

        let mut required = HashSet::new();
        required.insert(pid("host"));
        required.insert(pid("alice"));
        let mut vote = PendingVote::new(
            "tool-1".into(),
            required,
            serde_json::json!({"allowedPrompts": [{"tool": "Edit", "prompt": "ok"}]}),
        );
        vote.votes.insert(pid("alice"), Vote::Approve);
        *room.pending_vote.write().await = Some(vote);

        let snapshot = room.pending_vote_snapshot().await.expect("snapshot");
        assert_eq!(snapshot.tool_use_id, "tool-1");
        assert_eq!(snapshot.required_voters.len(), 2);
        assert_eq!(
            snapshot.votes.get("alice").expect("alice vote"),
            &Vote::Approve
        );
        assert_eq!(
            snapshot.input["allowedPrompts"][0]["tool"],
            serde_json::json!("Edit")
        );
    }

    #[tokio::test]
    async fn registry_pending_vote_snapshot_backfills_from_provider() {
        let reg = RoomRegistry::new();
        reg.set_pending_vote_snapshot_provider(|session_id| async move {
            Some(PendingVoteSnapshot {
                tool_use_id: format!("{session_id}-tool"),
                required_voters: vec![info("host", true)],
                votes: HashMap::new(),
                input: serde_json::json!({"allowedPrompts": []}),
                plan_file_path: None,
            })
        });

        let snapshot = reg
            .pending_vote_snapshot("s1")
            .await
            .expect("provider snapshot");
        assert_eq!(snapshot.tool_use_id, "s1-tool");
    }

    #[tokio::test]
    async fn registry_pending_question_snapshot_backfills_from_provider() {
        let reg = RoomRegistry::new();
        reg.set_pending_question_snapshot_provider(|session_id| async move {
            Some(PendingQuestionSnapshot {
                tool_use_id: format!("{session_id}-tool"),
                required_voters: vec![info("host", true)],
                votes: HashMap::new(),
                input: serde_json::json!({
                    "question": "Pick one",
                    "options": ["A", "B"],
                }),
            })
        });

        let snapshot = reg
            .pending_question_snapshot("s1")
            .await
            .expect("provider snapshot");
        assert_eq!(snapshot.tool_use_id, "s1-tool");
        assert_eq!(snapshot.input["question"], serde_json::json!("Pick one"));
    }

    #[tokio::test]
    async fn pending_vote_snapshot_allows_non_consensus_prompt() {
        let room = Room::new("s1".into(), true);
        let vote = PendingVote::new(
            "tool-1".into(),
            HashSet::new(),
            serde_json::json!({"allowedPrompts": []}),
        );
        *room.pending_vote.write().await = Some(vote);

        let snapshot = room.pending_vote_snapshot().await.expect("snapshot");
        assert_eq!(snapshot.tool_use_id, "tool-1");
        assert!(snapshot.required_voters.is_empty());
        assert!(snapshot.votes.is_empty());
    }
}
