//! Tauri-side glue for the interactive-session boot reconciler.
//!
//! Wraps [`claudette::interactive::reattach_rows`] in a boot-safe
//! shape: groups the persisted `running` rows by workspace, resolves
//! the cached [`InteractiveHost`](claudette::agent::interactive_host::InteractiveHost)
//! through [`AppState::interactive_host_for`], and runs the reconciler
//! against that host. Failures (DB unreadable, host unavailable,
//! status RPC errored) are logged and isolated per workspace so a
//! single bad row can't wedge the rest of the boot path.
//!
//! The matching lib-level functions live in `claudette::interactive`
//! and are the testable units; this file is the thin "wire it into
//! the AppState" layer.
//!
//! Threading note: `claudette::interactive::reattach_rows` borrows a
//! `claudette::db::Database` across an `await` on `host.status()`,
//! and `Database` wraps a `!Sync` `rusqlite::Connection`. The
//! resulting future is therefore not `Send`, so we cannot park it
//! directly on a multi-thread Tokio runtime via
//! `tauri::async_runtime::spawn`. Instead, this module spawns a
//! single blocking thread, builds a `current_thread` Tokio runtime
//! there, and drives the reconciler for every workspace inside that
//! runtime. Crucially, the DB connection is opened ONCE inside that
//! blocking thread and reused across workspaces — opening per
//! workspace would risk concurrent `Database::open` calls fighting
//! for the SQLite OS-level lock and surfacing as `SQLITE_BUSY` on
//! non-WAL databases.
//!
//! Each per-workspace host is resolved up-front on the async caller
//! (because `interactive_host_for` is `async` and may need to spawn
//! the sidecar). The resolved `(workspace_id, host, rows)` tuples are
//! then shipped into the single blocking task that owns the DB
//! handle.

use std::collections::HashMap;

use claudette::agent::interactive_host::InteractiveHost;
use claudette::db::{Database, InteractiveSessionRow};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::state::AppState;

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

    // Phase 1: fetch all running rows in a single blocking task that
    // opens and closes its own DB connection. Doing this on the async
    // caller would block the multi-thread runtime on rusqlite I/O.
    let pending = match tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || -> Result<Vec<InteractiveSessionRow>, String> {
            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
            db.list_running_interactive_sessions()
                .map_err(|e| e.to_string())
        }
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

    // Phase 2: resolve each workspace's host on the async caller.
    // `interactive_host_for` is `async` (may spawn the sidecar), so
    // we can't do this inside the single-threaded blocking task. We
    // collect everything that resolves successfully into a list of
    // `(workspace_id, host, rows)` tuples and ship that list into the
    // one blocking task that owns the DB handle.
    let mut resolved: Vec<(String, Arc<dyn InteractiveHost>, Vec<InteractiveSessionRow>)> =
        Vec::with_capacity(by_workspace.len());
    for (workspace_id, rows) in by_workspace {
        match state.interactive_host_for(&workspace_id).await {
            Ok(host) => resolved.push((workspace_id, host, rows)),
            Err(err) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    %workspace_id,
                    rows = rows.len(),
                    error = %err,
                    "boot reconciler: could not resolve host; leaving rows as running",
                );
            }
        }
    }

    if resolved.is_empty() {
        return;
    }

    // Phase 3: one blocking task, one DB connection, current-thread
    // Tokio runtime so the `!Send` future from `reattach_rows` is
    // legal. Per-workspace errors are logged and isolated; a single
    // failing workspace must not abort the rest of the reconciliation.
    let db_path_inner = db_path.clone();
    let join = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let db = Database::open(&db_path_inner).map_err(|e| e.to_string())?;
        rt.block_on(async move {
            for (workspace_id, host, rows) in resolved {
                if let Err(err) =
                    claudette::interactive::reattach_rows(&db, &rows, host.as_ref()).await
                {
                    tracing::warn!(
                        target: "claudette::interactive",
                        workspace_id = %workspace_id,
                        error = %err,
                        "boot reconciler: reattach_rows failed",
                    );
                }
            }
        });
        Ok(())
    })
    .await;
    match join {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            tracing::warn!(
                target: "claudette::interactive",
                error = %err,
                "boot reconciler: blocking task setup failed",
            );
        }
        Err(join_err) => {
            tracing::warn!(
                target: "claudette::interactive",
                error = %join_err,
                "boot reconciler: join failed",
            );
        }
    }
}
