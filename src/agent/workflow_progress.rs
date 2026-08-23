//! Terminal-status vocabulary for background tasks, and reconciliation of a
//! `Workflow` run's progress tree against that status.
//!
//! # Why this module exists
//!
//! Two independent facts describe a backgrounded `Workflow`:
//!
//! * its **task status** — `running` until a terminal `task_notification`
//!   arrives, then `completed` / `failed` / `stopped` / …
//! * its **progress tree** — the `workflow_progress` snapshot the CLI attaches
//!   to `task_progress` events, from which the UI derives "42 of 49 agents
//!   done".
//!
//! Nothing used to reconcile them, and they are delivered on different
//! schedules: the tree only accompanies real agent state transitions, while
//! the status arrives once at the end. A run whose last delivered snapshot
//! still showed agents in flight therefore kept advertising an unfinished
//! fraction forever, even after reporting `completed` — the "48/49 that never
//! goes away" bug. [`reconcile_tree_on_terminal`] closes that by stamping the
//! stragglers when the run's own status says it is over, which makes the
//! invariant *finished ⇒ no agent left non-terminal* hold by construction
//! instead of by hoping the last snapshot landed.
//!
//! The terminal-status set lives here too because it had drifted into three
//! copies — this crate, the Tauri command layer, and a SQL literal — with a
//! comment asking humans to keep them in sync. They now all read from
//! [`is_terminal_task_status`] / [`TERMINAL_TASK_STATUSES`].

use serde::Serialize;

use crate::agent::types::WorkflowProgressEntry;

/// Payload of the `workflow-activity-status` Tauri event.
///
/// Emitted when a backgrounded `Workflow` run reaches a terminal status, so
/// the open UI drops its status pill and settles its card without waiting for
/// a reload. The database write has already happened by the time this is sent
/// — this event is a live-update convenience, never the source of truth. That
/// split is deliberate: the store may not have the owning session hydrated
/// (its transcript was never opened, or the app restarted since), in which
/// case applying the event is a no-op and the next hydrate reads the correct
/// row from disk anyway.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowActivityStatusEvent {
    pub workspace_id: String,
    pub chat_session_id: String,
    pub tool_use_id: String,
    /// The run's own terminal status (`completed`, `failed`, …) — not a
    /// synthesized sentinel, so the card reports what actually happened.
    pub status: String,
    /// Reconciled progress tree. `None` when the row carried no readable tree,
    /// which the consumer must treat as "keep what you have" rather than
    /// "clear it".
    pub workflow_progress: Option<Vec<WorkflowProgressEntry>>,
}

/// Every status value that means a background task has ended.
///
/// The Claude CLI declares a closed enum for the notification that ends a run
/// (`status: z.enum(["completed", "failed", "stopped"])`). `"killed"` comes
/// from the adjacent `task_updated.patch.status` channel, which Claudette does
/// not consume yet but which must not be able to reintroduce a wedge if it is
/// ever wired up. `"error"` / `"cancelled"` / `"canceled"` appear in neither
/// schema and are tolerated aliases.
///
/// The asymmetry that justifies being generous here: a false positive costs a
/// finished run stopping being advertised, while a false negative is an
/// indicator that never goes away. The second is the failure this set exists
/// to prevent.
///
/// Kept in sync with `TERMINAL_BACKGROUND_TASK_STATUSES` in
/// `src/ui/src/types/backgroundTaskStatus.ts`, which the UI needs for rows
/// loaded straight from the database.
pub const TERMINAL_TASK_STATUSES: &[&str] = &[
    "completed",
    "failed",
    "stopped",
    "killed",
    "error",
    "cancelled",
    "canceled",
];

/// Whether a background task's status means the task itself has ended.
///
/// `""` is not terminal: a row checkpointed before its first progress tick has
/// no status yet and is genuinely still starting.
pub fn is_terminal_task_status(status: &str) -> bool {
    let status = status.trim().to_ascii_lowercase();
    TERMINAL_TASK_STATUSES.contains(&status.as_str())
}

/// Status recorded for a background task whose owning CLI process went away
/// without ever reporting an outcome.
///
/// Deliberately `"stopped"` rather than a Claudette-specific sentinel: it is a
/// real value in the CLI's own `task_notification` enum with exactly this
/// meaning, so a reaped row needs no special-casing at any read site. Mirrored
/// by `REAPED_BACKGROUND_TASK_STATUS` in
/// `src/ui/src/types/backgroundTaskStatus.ts`.
pub const REAPED_TASK_STATUS: &str = "stopped";

/// Agent states that will not change again.
///
/// `"stopped"` is included so [`reconcile_tree_on_terminal`] has an honest
/// value for an agent that never finished on a run that did not complete —
/// stamping those `"done"` would claim work that never happened, and stamping
/// them `"error"` would inflate the failure badge for a run the user simply
/// cancelled. Mirrored by `TERMINAL_AGENT_STATES` in
/// `src/ui/src/types/workflow.ts`.
const TERMINAL_AGENT_STATES: &[&str] = &["done", "error", "stopped"];

fn is_terminal_agent_state(state: &str) -> bool {
    TERMINAL_AGENT_STATES.contains(&state.trim().to_ascii_lowercase().as_str())
}

/// The state to stamp on agents still in flight when a run reaches `status`.
///
/// Only a `completed` run may claim its stragglers finished their work; every
/// other terminal status means the run ended without them getting there.
fn straggler_state_for(status: &str) -> &'static str {
    if status.trim().eq_ignore_ascii_case("completed") {
        "done"
    } else {
        "stopped"
    }
}

/// Stamp every non-terminal agent in `entries` as terminal, because the run
/// that owns them has reported `status`.
///
/// No-op unless `status` is terminal, so a `running` tick can never
/// prematurely close out agents. Agents already in a terminal state keep the
/// state they reported — a genuine `error` is never rewritten to `done` by a
/// run that completed despite it.
///
/// Returns the number of agents changed, so callers can skip a database write
/// when there was nothing to fix.
pub fn reconcile_tree_on_terminal(entries: &mut [WorkflowProgressEntry], status: &str) -> usize {
    if !is_terminal_task_status(status) {
        return 0;
    }
    let stamped = straggler_state_for(status);
    let mut changed = 0;
    for entry in entries.iter_mut() {
        // Phase headings and entry kinds we don't model carry no state to
        // reconcile. `Unknown` deliberately stays untouched rather than being
        // dropped: it round-trips as `{"type":"Unknown"}` either way, and
        // discarding entries here would silently shrink a tree the UI keys on
        // by position.
        let WorkflowProgressEntry::Agent(agent) = entry else {
            continue;
        };
        if is_terminal_agent_state(&agent.state) {
            continue;
        }
        agent.state = stamped.to_string();
        changed += 1;
    }
    changed
}

/// Apply [`reconcile_tree_on_terminal`] to a serialized tree.
///
/// Returns `None` when nothing changed — including when the JSON is
/// unparseable. A tree we cannot read is one we must not overwrite: the stored
/// value is the only copy, and replacing it with `[]` would turn a stale
/// display into a permanently blank one.
pub fn reconcile_tree_json_on_terminal(tree_json: &str, status: &str) -> Option<String> {
    if !is_terminal_task_status(status) {
        return None;
    }
    let mut entries: Vec<WorkflowProgressEntry> = serde_json::from_str(tree_json).ok()?;
    if reconcile_tree_on_terminal(&mut entries, status) == 0 {
        return None;
    }
    serde_json::to_string(&entries).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::WorkflowAgentProgress;

    fn agent(index: i64, state: &str) -> WorkflowProgressEntry {
        WorkflowProgressEntry::Agent(Box::new(WorkflowAgentProgress {
            index,
            label: format!("agent-{index}"),
            state: state.to_string(),
            ..Default::default()
        }))
    }

    fn state_of(entry: &WorkflowProgressEntry) -> &str {
        match entry {
            WorkflowProgressEntry::Agent(a) => a.state.as_str(),
            _ => "",
        }
    }

    #[test]
    fn terminal_status_set_includes_the_alias_the_command_layer_used_to_miss() {
        // Regression: `background_tasks.rs` had its own copy of this set that
        // omitted "error", so an `error` notification re-armed the wake and
        // never resolved the activity. Every copy now delegates here.
        for status in ["completed", "failed", "stopped", "killed", "error"] {
            assert!(is_terminal_task_status(status), "{status} must be terminal");
        }
        assert!(is_terminal_task_status("Completed"), "case-insensitive");
        assert!(is_terminal_task_status("  failed  "), "trimmed");
    }

    #[test]
    fn in_flight_statuses_are_not_terminal() {
        for status in ["running", "starting", "paused", "", "  "] {
            assert!(
                !is_terminal_task_status(status),
                "{status:?} must not be terminal"
            );
        }
    }

    #[test]
    fn completed_run_stamps_stragglers_done() {
        // The exact shape behind the reported bug: every agent still reads
        // `progress` in the last snapshot that reached us, so the UI renders
        // "0/5" for a run that finished.
        let mut tree = vec![
            WorkflowProgressEntry::Phase {
                index: 0,
                title: "Investigate".to_string(),
            },
            agent(1, "progress"),
            agent(2, "progress"),
            agent(3, "queued"),
        ];
        assert_eq!(reconcile_tree_on_terminal(&mut tree, "completed"), 3);
        assert_eq!(state_of(&tree[1]), "done");
        assert_eq!(state_of(&tree[2]), "done");
        assert_eq!(state_of(&tree[3]), "done");
        // The phase heading survives — the UI keys its grouping on it.
        assert!(matches!(tree[0], WorkflowProgressEntry::Phase { .. }));
    }

    #[test]
    fn non_completed_terminal_status_stamps_stopped_not_done() {
        // A cancelled run must not claim its unfinished agents succeeded, and
        // must not inflate the failure badge either.
        for status in ["stopped", "killed", "cancelled"] {
            let mut tree = vec![agent(1, "progress")];
            assert_eq!(reconcile_tree_on_terminal(&mut tree, status), 1);
            assert_eq!(state_of(&tree[0]), "stopped", "for status {status}");
        }
    }

    #[test]
    fn already_terminal_agents_keep_their_own_outcome() {
        // A run can complete with a failed agent (the script filtered it out).
        // Rewriting that to `done` would erase a real failure from the card.
        let mut tree = vec![agent(1, "done"), agent(2, "error"), agent(3, "progress")];
        assert_eq!(reconcile_tree_on_terminal(&mut tree, "completed"), 1);
        assert_eq!(state_of(&tree[0]), "done");
        assert_eq!(state_of(&tree[1]), "error");
        assert_eq!(state_of(&tree[2]), "done");
    }

    #[test]
    fn non_terminal_status_is_a_no_op() {
        // Guards the ordering hazard: reconciliation is driven by the same
        // notification path that also sees `running` ticks, and closing agents
        // out on one of those would freeze a live run's card.
        let mut tree = vec![agent(1, "progress"), agent(2, "queued")];
        assert_eq!(reconcile_tree_on_terminal(&mut tree, "running"), 0);
        assert_eq!(state_of(&tree[0]), "progress");
        assert_eq!(state_of(&tree[1]), "queued");
    }

    #[test]
    fn unknown_entries_are_preserved_not_dropped() {
        let mut tree = vec![
            WorkflowProgressEntry::Unknown,
            agent(1, "progress"),
            WorkflowProgressEntry::Unknown,
        ];
        assert_eq!(reconcile_tree_on_terminal(&mut tree, "completed"), 1);
        assert_eq!(tree.len(), 3);
        assert!(matches!(tree[0], WorkflowProgressEntry::Unknown));
        assert!(matches!(tree[2], WorkflowProgressEntry::Unknown));
    }

    #[test]
    fn json_helper_returns_none_when_nothing_changes() {
        let already_done = r#"[{"type":"workflow_agent","index":1,"label":"a","state":"done"}]"#;
        assert_eq!(
            reconcile_tree_json_on_terminal(already_done, "completed"),
            None
        );
        assert_eq!(reconcile_tree_json_on_terminal("[]", "completed"), None);
    }

    #[test]
    fn json_helper_refuses_to_rewrite_an_unparseable_tree() {
        // The stored tree is the only copy. Replacing garbage with `[]` would
        // convert a stale card into a permanently blank one.
        assert_eq!(
            reconcile_tree_json_on_terminal("not json", "completed"),
            None
        );
        assert_eq!(
            reconcile_tree_json_on_terminal(r#"{"not":"an array"}"#, "completed"),
            None
        );
    }

    #[test]
    fn json_helper_round_trips_a_reconciled_tree() {
        let json = r#"[{"type":"workflow_phase","index":0,"title":"Investigate"},
                       {"type":"workflow_agent","index":1,"label":"probe","state":"progress"}]"#;
        let out = reconcile_tree_json_on_terminal(json, "completed").expect("tree changed");
        let entries: Vec<WorkflowProgressEntry> = serde_json::from_str(&out).unwrap();
        assert_eq!(state_of(&entries[1]), "done");
        assert!(matches!(entries[0], WorkflowProgressEntry::Phase { .. }));
    }
}
