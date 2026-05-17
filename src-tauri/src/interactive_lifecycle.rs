//! Tauri-side glue for the interactive-session boot reconciler.
//!
//! Wraps [`claudette::interactive::reattach_pending`] in a boot-safe
//! shape: groups the persisted `running` rows by workspace, resolves
//! the cached [`InteractiveHost`](claudette::agent::interactive_host::InteractiveHost)
//! through [`AppState::interactive_host_for`], and runs the reconciler
//! against that host. Failures (DB unreadable, host unavailable,
//! status RPC errored) are logged and isolated per workspace so a
//! single bad row can't wedge the rest of the boot path.
//!
//! The matching lib-level function lives in `claudette::interactive`
//! and is the testable unit; this file is the thin "wire it into the
//! AppState" layer.
//!
//! Threading note: `claudette::interactive::reattach_pending` borrows
//! a `claudette::db::Database` across an `await` on `host.status()`,
//! and `Database` wraps a `!Sync` `rusqlite::Connection`. The
//! resulting future is therefore not `Send`, so we cannot park it
//! directly on a multi-thread Tokio runtime via
//! `tauri::async_runtime::spawn`. Instead, this module spawns a
//! blocking thread, builds a `current_thread` Tokio runtime there,
//! and drives the reconciler inside that runtime — the DB connection
//! never leaves the blocking thread, but the async host call still
//! works because we have a runtime locally.

use std::collections::HashMap;
use std::path::Path;

use claudette::agent::interactive_host::InteractiveHost;
use claudette::db::{Database, InteractiveSessionRow};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Open the DB and pull every `running` interactive session row.
/// The string error is just the `Display` form of the underlying
/// `rusqlite::Error` — keeping the concrete type out of
/// `claudette-tauri`'s dep tree (`rusqlite` is a transitive dep of
/// `claudette` only).
fn fetch_running_rows(db_path: &Path) -> Result<Vec<InteractiveSessionRow>, String> {
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    db.list_running_interactive_sessions()
        .map_err(|e| e.to_string())
}

/// Reconcile every persisted `interactive_sessions` row currently in
/// `state = 'running'` against the live host. See module docs for the
/// behavior contract.
///
/// Spawned from `main.rs::setup` on a background Tokio task — the
/// startup path waits for none of this. The reconciler only writes to
/// the DB when the host's `status()` succeeds, so a transient
/// unavailable-host condition leaves the row alone for the next boot
/// to handle.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn reattach_interactive_sessions_on_boot(app: AppHandle) {
    let state = app.state::<AppState>();
    let db_path = state.db_path.clone();

    let pending = match tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || fetch_running_rows(&db_path)
    })
    .await
    {
        Ok(Ok(rows)) => rows,
        Ok(Err(err)) => {
            tracing::warn!(
                target: "claudette::interactive",
                error = %err,
                "boot reconciler: failed to read running sessions; skipping"
            );
            return;
        }
        Err(join_err) => {
            tracing::warn!(
                target: "claudette::interactive",
                error = %join_err,
                "boot reconciler: spawn_blocking failed; skipping"
            );
            return;
        }
    };

    if pending.is_empty() {
        // Fast path: don't touch hosts at all when there's no work.
        // Important: `interactive_host_for` can spawn the sidecar
        // binary; we don't want that side-effect on boots where it
        // wouldn't otherwise be needed.
        return;
    }

    // Group by workspace so we resolve each host exactly once even
    // when a workspace has multiple stale rows.
    let mut by_workspace: HashMap<String, Vec<InteractiveSessionRow>> = HashMap::new();
    for row in pending {
        by_workspace
            .entry(row.workspace_id.clone())
            .or_default()
            .push(row);
    }

    for (workspace_id, rows) in by_workspace {
        let host = match state.interactive_host_for(&workspace_id).await {
            Ok(h) => h,
            Err(err) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    %workspace_id,
                    rows = rows.len(),
                    error = %err,
                    "boot reconciler: could not resolve host; leaving rows as running",
                );
                continue;
            }
        };

        // Drive `reattach_pending` on a blocking thread with a
        // single-threaded Tokio runtime. The reconciler awaits the
        // host but holds a `!Sync` `Database` borrow across the
        // await — running it inside `current_thread` (no work
        // stealing) means the borrow never crosses thread boundaries
        // and the future doesn't need `Send`.
        let workspace_id_clone = workspace_id.clone();
        let db_path_inner = state.db_path.clone();
        let host_clone: Arc<dyn InteractiveHost> = Arc::clone(&host);
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| e.to_string())?;
            rt.block_on(async move {
                let db = Database::open(&db_path_inner).map_err(|e| e.to_string())?;
                claudette::interactive::reattach_pending(&db, host_clone.as_ref())
                    .await
                    .map_err(|e| e.to_string())
            })
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    workspace_id = %workspace_id_clone,
                    error = %err,
                    "boot reconciler: reattach_pending failed",
                );
            }
            Err(join_err) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    workspace_id = %workspace_id_clone,
                    error = %join_err,
                    "boot reconciler: join failed",
                );
            }
        }
    }
}
