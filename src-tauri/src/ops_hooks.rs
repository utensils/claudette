//! GUI implementation of [`claudette::ops::OpsHooks`].
//!
//! Every Tauri command that calls into `claudette::ops::*` constructs a
//! `TauriHooks` and passes it to the op so workspace lifecycle events
//! produce the same tray rebuilds and notification sounds users see in
//! the rest of the app — regardless of whether the change came from the
//! GUI itself, the local-IPC channel used by the CLI, or a future
//! provider that drives ops on its own.

use std::sync::Arc;

use claudette::ops::{NotificationEvent as OpsNotificationEvent, OpsHooks, WorkspaceChangeKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::tray::{NotificationEvent as TrayNotificationEvent, rebuild_tray, resolve_notification};

/// Frontend payload for `workspaces-changed`. The full workspace row
/// rides on the event so the React store can `addWorkspace` /
/// `updateWorkspace` directly without a follow-up `load_initial_data`
/// round trip.
#[derive(Serialize, Clone)]
struct WorkspacesChangedEvent {
    kind: &'static str,
    workspace_id: String,
    workspace: Option<claudette::model::Workspace>,
}

/// Hooks impl backed by the running Tauri app. Cheap to construct and clone
/// (`Arc`-clones the inner handle), so callers that need a `dyn OpsHooks`
/// can build one per request without contention.
pub struct TauriHooks {
    app: AppHandle,
}

impl TauriHooks {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl OpsHooks for TauriHooks {
    fn workspace_changed(&self, workspace_id: &str, kind: WorkspaceChangeKind) {
        rebuild_tray(&self.app);

        // Push the change to the frontend so CLI- and remote-driven
        // creates/archives appear without a manual reload. The fresh
        // workspace row is fetched from the DB so the store can update
        // in one shot — falling back to a payload with `workspace: null`
        // means the frontend can still re-fetch via `load_initial_data`.
        let workspace = self
            .app
            .try_state::<AppState>()
            .and_then(|state| {
                claudette::db::Database::open(&state.db_path)
                    .ok()
                    .and_then(|db| db.list_workspaces().ok())
            })
            .and_then(|all| all.into_iter().find(|w| w.id == workspace_id));

        let payload = WorkspacesChangedEvent {
            kind: match kind {
                WorkspaceChangeKind::Created => "created",
                WorkspaceChangeKind::Archived => "archived",
                WorkspaceChangeKind::Restored => "restored",
                WorkspaceChangeKind::Deleted => "deleted",
                WorkspaceChangeKind::Renamed => "renamed",
            },
            workspace_id: workspace_id.to_string(),
            workspace,
        };
        let _ = self.app.emit("workspaces-changed", payload);
    }

    /// Override note: this implementation **intentionally diverges from
    /// the default trait impl** (which loops per-row over
    /// [`workspace_changed`]). The reason is amortization — the 72-row
    /// motivating case would do 72 tray rebuilds + 72 DB re-opens + 72
    /// `list_workspaces` scans otherwise.
    ///
    /// Contract: this method must produce the same observable side
    /// effects as N calls to [`workspace_changed`] would — same tray
    /// state, same set of `workspaces-changed` events on the frontend,
    /// same notification semantics. If a new side effect is ever added
    /// to [`workspace_changed`], it must also be added here (or pulled
    /// out into a shared helper that both call). The bulk variant is
    /// not a "subset of per-row side effects" — it's the same surface
    /// computed more cheaply.
    fn workspaces_changed_bulk(&self, workspace_ids: &[String], kind: WorkspaceChangeKind) {
        if workspace_ids.is_empty() {
            return;
        }

        // One tray rebuild for the whole batch — the 72-archived case
        // (the motivating example for bulk cleanup) used to fire 72
        // rebuilds + 72 DB re-opens inside one IPC call.
        rebuild_tray(&self.app);

        // One DB query to look up every still-extant workspace row
        // referenced by the batch. For `Deleted` the rows are gone, so
        // we skip the lookup entirely and emit `{ workspace: null }`.
        let workspaces_by_id = if kind == WorkspaceChangeKind::Deleted {
            None
        } else {
            self.app
                .try_state::<AppState>()
                .and_then(|state| {
                    claudette::db::Database::open(&state.db_path)
                        .ok()
                        .and_then(|db| db.list_workspaces().ok())
                })
                .map(|all| {
                    all.into_iter()
                        .map(|w| (w.id.clone(), w))
                        .collect::<std::collections::HashMap<_, _>>()
                })
        };

        let kind_str = match kind {
            WorkspaceChangeKind::Created => "created",
            WorkspaceChangeKind::Archived => "archived",
            WorkspaceChangeKind::Restored => "restored",
            WorkspaceChangeKind::Deleted => "deleted",
            WorkspaceChangeKind::Renamed => "renamed",
        };

        for id in workspace_ids {
            let workspace = workspaces_by_id
                .as_ref()
                .and_then(|map| map.get(id).cloned());
            let payload = WorkspacesChangedEvent {
                kind: kind_str,
                workspace_id: id.clone(),
                workspace,
            };
            let _ = self.app.emit("workspaces-changed", payload);
        }
    }

    fn notification(&self, event: OpsNotificationEvent) {
        let state = self.app.try_state::<AppState>();
        if let Some(state) = state {
            // Re-open the DB instead of holding a long-lived handle: a
            // fresh `Connection` per call keeps `Send` happy and matches
            // the convention used elsewhere in `commands/`.
            let Ok(db) = claudette::db::Database::open(&state.db_path) else {
                return;
            };
            let resolved = resolve_notification(&db, &state.cesp_playback, map_event(event));
            if resolved.sound != "None" {
                crate::commands::settings::play_notification_sound(
                    resolved.sound,
                    Some(resolved.volume),
                );
            }
        }
    }
}

fn map_event(event: OpsNotificationEvent) -> TrayNotificationEvent {
    match event {
        OpsNotificationEvent::Ask => TrayNotificationEvent::Ask,
        OpsNotificationEvent::Plan => TrayNotificationEvent::Plan,
        OpsNotificationEvent::Finished => TrayNotificationEvent::Finished,
        OpsNotificationEvent::Error => TrayNotificationEvent::Error,
        OpsNotificationEvent::SessionStart => TrayNotificationEvent::SessionStart,
    }
}
