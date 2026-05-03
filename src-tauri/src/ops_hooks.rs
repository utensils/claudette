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
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::tray::{NotificationEvent as TrayNotificationEvent, rebuild_tray, resolve_notification};

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
    fn workspace_changed(&self, _workspace_id: &str, _kind: WorkspaceChangeKind) {
        rebuild_tray(&self.app);
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
