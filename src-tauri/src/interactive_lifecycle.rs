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
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Wire payload for `interactive://orphans-detected`. Emitted once
/// during boot if the reconciler finds any orphan sids on the host
/// that the DB doesn't know about. The frontend uses this to show a
/// one-shot toast / banner with a "Clean up" button bound to the
/// `interactive_cleanup_orphans` command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrphansDetectedPayload {
    sids: Vec<String>,
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

    // Gate the reconciler on the experimental flag so users who have
    // never enabled `claudeInteractiveEnabled` don't pay the cost of
    // spawning the bundled `claudette-session-host` sidecar at every
    // boot. Stale `running` rows from a prior install or a flag-toggle
    // are left as-is in the DB; the next boot after the user re-enables
    // the flag will reconcile them.
    if !state.claude_interactive_enabled().await {
        tracing::info!(
            target: "claudette::interactive",
            "boot reconciler: claudeInteractiveEnabled is off; skipping",
        );
        return;
    }

    let db_path = state.db_path.clone();

    // Phase 1: fetch (a) all running rows for reclassification and
    // (b) the full set of known sids for orphan detection in a single
    // blocking task that opens and closes its own DB connection. Doing
    // this on the async caller would block the multi-thread runtime on
    // rusqlite I/O.
    //
    // We snapshot ALL sids (not just running ones) because a
    // crashed/detached/stopped row is still a row the DB knows about —
    // its sid must NOT count as an orphan even though the host might
    // happen to still be holding the session under the same name.
    let (pending, known_sids) = match tokio::task::spawn_blocking({
        let db_path = db_path.clone();
        move || -> Result<(Vec<InteractiveSessionRow>, Vec<String>), String> {
            let db = Database::open(&db_path).map_err(|e| e.to_string())?;
            let running = db
                .list_running_interactive_sessions()
                .map_err(|e| e.to_string())?;
            let known = db
                .list_all_interactive_session_sids()
                .map_err(|e| e.to_string())?;
            Ok((running, known))
        }
    })
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(err)) => {
            tracing::warn!(
                target: "claudette::interactive",
                error = %err,
                "boot reconciler: failed to read sessions; skipping"
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

    if pending.is_empty() && known_sids.is_empty() {
        // Fast path: no DB-tracked sessions AND no records to reconcile.
        // We still skip the host probe here because resolving a host
        // when the DB never had any interactive sessions would spawn
        // the sidecar binary for no useful reason. The orphan check on
        // a totally cold DB is also moot — Claudette could not have
        // created any orphans without ever persisting a row.
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

    // Phase 2b: orphan detection. We need to ask SOME host
    // `status()` to see what sessions actually exist. Every workspace
    // shares the same backend selection (tmux server / sidecar
    // socket), so the first successfully-resolved host is
    // representative. If we couldn't resolve any host via the running
    // rows (e.g. all of them failed host resolution OR there were no
    // running rows but there were historical ones), fall back to
    // resolving a host against the workspace of the first known sid
    // we still have on file. In the cold case where no workspace can
    // resolve a host, we skip orphan detection — the user can't have
    // accumulated orphans we can clean up either.
    let orphan_host: Option<Arc<dyn InteractiveHost>> = if let Some((_, host, _)) = resolved.first()
    {
        Some(Arc::clone(host))
    } else {
        // No host resolved yet. Try to resolve one from any workspace
        // that historically owned an interactive session. We probe
        // `known_sids` for sids whose `claudette-<wsshort>-` prefix
        // points at a workspace we can look up. In practice this is
        // rare — running rows would normally cover the same workspaces
        // — but it matters when the only known DB rows are
        // crashed/stopped and the user wants stale host sessions
        // cleaned up.
        let mut probed: Option<Arc<dyn InteractiveHost>> = None;
        // The list_workspaces query is cheap; do it once.
        let workspaces_for_probe = tokio::task::spawn_blocking({
            let db_path = db_path.clone();
            move || -> Result<Vec<String>, String> {
                let db = Database::open(&db_path).map_err(|e| e.to_string())?;
                db.list_workspaces()
                    .map(|rows| rows.into_iter().map(|w| w.id).collect())
                    .map_err(|e| e.to_string())
            }
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
        for ws_id in workspaces_for_probe {
            if let Ok(host) = state.interactive_host_for(&ws_id).await {
                probed = Some(host);
                break;
            }
        }
        probed
    };

    if let Some(host) = orphan_host {
        match claudette::interactive::detect_orphans(&known_sids, host.as_ref()).await {
            Ok(orphans) if !orphans.is_empty() => {
                let sids: Vec<String> = orphans.iter().map(|s| s.0.clone()).collect();
                tracing::info!(
                    target: "claudette::interactive",
                    count = sids.len(),
                    "boot reconciler: detected orphan host sessions",
                );
                // Stash sid → host into AppState so
                // `interactive_cleanup_orphans` can stop them without
                // needing to re-resolve which workspace they came from.
                {
                    let mut map = state.interactive_orphans.write().await;
                    for sid in &sids {
                        map.insert(sid.clone(), Arc::clone(&host));
                    }
                }
                let payload = OrphansDetectedPayload { sids };
                if let Err(err) = app.emit("interactive://orphans-detected", &payload) {
                    tracing::warn!(
                        target: "claudette::interactive",
                        error = %err,
                        "boot reconciler: failed to emit orphans-detected event",
                    );
                }
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    target: "claudette::interactive",
                    error = %err,
                    "boot reconciler: orphan detection failed; skipping",
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
