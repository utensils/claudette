//! Regression coverage for the bug where archiving a host workspace
//! left a "ghost" entry on every connected remote claudette.
//!
//! Two surfaces matter:
//!   1. The pull-side filter — `list_workspaces` / `load_initial_data`
//!      must exclude `WorkspaceStatus::Archived`, so reconnects don't
//!      re-surface the archived workspace.
//!   2. The push-side fanout — archiving must publish a
//!      `WorkspaceEvent::Archived` to the shared `WorkspaceEventBus` so
//!      currently-connected remotes drop the workspace immediately,
//!      regardless of which (if any) chat session they have open.
//!
//! Spinning up the whole TLS+WS stack here would be overkill — we
//! exercise the underlying primitives that the handler delegates to.
//! Together with the WS forwarder in `ws.rs` (which is a thin
//! `subscribe → filter → forward` loop) this covers the bug end-to-end.

use std::sync::Arc;

use claudette::db::Database;
use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
use claudette::workspace_events::{WorkspaceEvent, WorkspaceEventBus};

fn make_repo(id: &str) -> Repository {
    Repository {
        id: id.into(),
        path: format!("/tmp/{id}"),
        name: format!("repo-{id}"),
        path_slug: format!("repo-{id}"),
        icon: None,
        created_at: "2026-01-01 00:00:00".into(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        archive_script: None,
        archive_script_auto_run: false,
        base_branch: None,
        default_remote: None,
        path_valid: true,
    }
}

fn make_workspace(id: &str, repo_id: &str, status: WorkspaceStatus) -> Workspace {
    Workspace {
        id: id.into(),
        repository_id: repo_id.into(),
        name: format!("ws-{id}"),
        branch_name: "main".into(),
        worktree_path: Some(format!("/tmp/{id}-wt")),
        status,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        sort_order: 0,
        created_at: "2026-01-01 00:00:00".into(),
    }
}

/// The handler's `list_workspaces` / `load_initial_data` arms apply
/// `status == Active` after the access-scope check. This test pins
/// down the underlying behavior: `db.list_workspaces()` returns both
/// active and archived rows, and the filter the handler uses cleanly
/// separates them. If `list_workspaces` ever silently changes semantics
/// (e.g. starts excluding archived rows internally) this test fails
/// loud, prompting a re-review of the handler-side filter.
#[test]
fn list_workspaces_returns_active_and_archived_until_filtered() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let db = Database::open(&db_path).unwrap();

    db.insert_repository(&make_repo("r1")).unwrap();
    db.insert_workspace(&make_workspace("active-1", "r1", WorkspaceStatus::Active))
        .unwrap();
    db.insert_workspace(&make_workspace("active-2", "r1", WorkspaceStatus::Active))
        .unwrap();
    db.insert_workspace(&make_workspace(
        "archived-1",
        "r1",
        WorkspaceStatus::Archived,
    ))
    .unwrap();

    let all = db.list_workspaces().unwrap();
    assert_eq!(
        all.len(),
        3,
        "DB layer must surface every workspace regardless of status \
         — the handler is the layer responsible for filtering"
    );

    // Same predicate the handler applies.
    let visible_to_remote: Vec<_> = all
        .into_iter()
        .filter(|w| w.status == WorkspaceStatus::Active)
        .collect();
    let visible_ids: Vec<_> = visible_to_remote.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(visible_ids, vec!["active-1", "active-2"]);
}

/// After the host archives a workspace, the bus must fan the event out
/// to every subscriber. The WS connection forwarder in `ws.rs` is one
/// such subscriber — it filters by the connection's allowed-workspaces
/// scope and writes the event to the socket. This test pins down the
/// publish/subscribe contract that whole pipeline depends on.
#[tokio::test]
async fn workspace_event_bus_fans_archive_to_all_subscribers() {
    let bus = Arc::new(WorkspaceEventBus::new());

    // Two subscribers stand in for two connected remotes.
    let mut rx_a = bus.subscribe();
    let mut rx_b = bus.subscribe();

    bus.publish(WorkspaceEvent::Archived {
        workspace_id: "ws-42".into(),
    });

    let evt_a = tokio::time::timeout(std::time::Duration::from_secs(1), rx_a.recv())
        .await
        .expect("subscriber A must receive the event before the timeout")
        .expect("subscriber A must not see a Lagged/Closed error");
    let evt_b = tokio::time::timeout(std::time::Duration::from_secs(1), rx_b.recv())
        .await
        .expect("subscriber B must receive the event before the timeout")
        .expect("subscriber B must not see a Lagged/Closed error");

    assert_eq!(evt_a.workspace_id(), "ws-42");
    assert_eq!(evt_b.workspace_id(), "ws-42");
}

/// Late-attaching subscribers don't observe past events — a deliberate
/// property of the broadcast channel (mirrors what a freshly-connected
/// remote sees: it relies on `load_initial_data` for the snapshot, not
/// on the bus). Pinning this down so we don't accidentally switch to a
/// replay channel without re-thinking the snapshot path.
#[tokio::test]
async fn workspace_event_bus_does_not_replay_for_late_subscribers() {
    let bus = WorkspaceEventBus::new();
    bus.publish(WorkspaceEvent::Archived {
        workspace_id: "ws-old".into(),
    });

    let mut rx = bus.subscribe();
    // Nothing buffered for a late subscriber. `try_recv` returns Empty
    // immediately rather than yielding the past event.
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}
