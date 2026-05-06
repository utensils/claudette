//! Cross-process broadcast bus for workspace lifecycle events.
//!
//! `Room` (see [`crate::room`]) is keyed by `chat_session_id` and only
//! reaches participants who explicitly `join_session`'d, so it can't carry
//! events that need to fan out to remote clients regardless of which (if
//! any) chat session they currently have open. The most concrete case:
//! when the host archives a workspace, every connected remote should
//! drop the workspace from its sidebar immediately — even if the user
//! is just looking at the workspace list and hasn't entered any chat.
//!
//! This bus solves that by giving the Tauri host and the embedded
//! `claudette-server` a shared `Arc<WorkspaceEventBus>` they both publish
//! into and the WebSocket connection loop subscribes to. Each connection
//! filters incoming events against its `allowed_workspace_ids` scope
//! before forwarding to its writer, so a remote never learns about
//! workspaces it wasn't granted access to.

use crate::model::Workspace;
use serde::Serialize;
use tokio::sync::broadcast;

/// Bounded broadcast capacity. Tuned for low-frequency lifecycle events
/// (archive / future rename, delete) — much smaller than the room
/// channel because nobody should be archiving 256 workspaces in flight.
const WORKSPACE_EVENT_CAPACITY: usize = 64;

/// Lifecycle events that need to reach every connected remote. Today
/// only `Archived` is emitted; new variants can be added as the host
/// surfaces other workspace mutations to remotes (rename, delete, etc.).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceEvent {
    /// The host (or a remote with archive permission) archived the
    /// workspace. Subscribers should remove it from their visible list.
    Archived { workspace_id: String },
    /// The host forked a workspace. Subscribers scoped to the source
    /// workspace should add/select the new workspace and continue there.
    Forked {
        source_workspace_id: String,
        workspace: Workspace,
    },
}

impl WorkspaceEvent {
    /// The workspace this event pertains to. Subscribers use this to
    /// filter against their allowed-workspaces scope before forwarding.
    pub fn workspace_id(&self) -> &str {
        match self {
            WorkspaceEvent::Archived { workspace_id } => workspace_id,
            WorkspaceEvent::Forked {
                source_workspace_id,
                ..
            } => source_workspace_id,
        }
    }
}

/// Process-wide bus for workspace lifecycle events. Construct one with
/// [`WorkspaceEventBus::new`] at startup; the Tauri host and the embedded
/// server share the same `Arc`.
///
/// `tokio::sync::broadcast` is lossy for slow subscribers — that's fine
/// here because the [`crate::model::WorkspaceStatus`] in the database is
/// the source of truth, and the next reconnect / `list_workspaces` call
/// will always reflect the latest state. The fast path just avoids the
/// reconnect.
pub struct WorkspaceEventBus {
    tx: broadcast::Sender<WorkspaceEvent>,
}

impl WorkspaceEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(WORKSPACE_EVENT_CAPACITY);
        Self { tx }
    }

    pub fn publish(&self, event: WorkspaceEvent) {
        // SendError (zero subscribers) is benign — no remote is currently
        // connected, and the next `load_initial_data` will reflect the
        // change anyway.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WorkspaceEvent> {
        self.tx.subscribe()
    }
}

impl Default for WorkspaceEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_fans_out_to_all_subscribers() {
        let bus = WorkspaceEventBus::new();
        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();
        bus.publish(WorkspaceEvent::Archived {
            workspace_id: "ws-1".into(),
        });
        let e1 = rx1.recv().await.unwrap();
        let e2 = rx2.recv().await.unwrap();
        assert_eq!(e1.workspace_id(), "ws-1");
        assert_eq!(e2.workspace_id(), "ws-1");
    }

    #[tokio::test]
    async fn publish_with_zero_subscribers_does_not_panic() {
        let bus = WorkspaceEventBus::new();
        bus.publish(WorkspaceEvent::Archived {
            workspace_id: "ws-1".into(),
        });
    }

    #[test]
    fn archived_event_serializes_with_kind_tag() {
        let evt = WorkspaceEvent::Archived {
            workspace_id: "ws-1".into(),
        };
        let json = serde_json::to_value(&evt).unwrap();
        assert_eq!(json["kind"], "archived");
        assert_eq!(json["workspace_id"], "ws-1");
    }

    #[test]
    fn forked_event_filters_by_source_workspace() {
        let evt = WorkspaceEvent::Forked {
            source_workspace_id: "source-ws".into(),
            workspace: Workspace {
                id: "fork-ws".into(),
                repository_id: "repo".into(),
                name: "Fork".into(),
                branch_name: "fork".into(),
                worktree_path: None,
                status: crate::model::WorkspaceStatus::Active,
                agent_status: crate::model::AgentStatus::Idle,
                status_line: String::new(),
                created_at: "now".into(),
                sort_order: 0,
            },
        };

        assert_eq!(evt.workspace_id(), "source-ws");
        let json = serde_json::to_value(&evt).unwrap();
        assert_eq!(json["kind"], "forked");
        assert_eq!(json["source_workspace_id"], "source-ws");
        assert_eq!(json["workspace"]["id"], "fork-ws");
    }
}
