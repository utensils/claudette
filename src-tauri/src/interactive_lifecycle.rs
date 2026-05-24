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
pub(crate) struct OrphansDetectedPayload {
    pub sids: Vec<String>,
}

/// Callback type used by the inner reconciler to emit the
/// `interactive://orphans-detected` Tauri event. Production wires this
/// to `AppHandle::emit`; tests inject a closure that records the
/// emission (or returns an error to exercise the emit-failure log
/// branch).
pub(crate) type OrphanEmitter =
    Box<dyn FnOnce(&OrphansDetectedPayload) -> Result<(), String> + Send>;

/// Reconcile every persisted `interactive_sessions` row currently in
/// `state = 'running'` against the live host. See module docs for the
/// behavior contract.
///
/// Spawned from `main.rs::setup` on a background Tokio task — the
/// startup path waits for none of this. The reconciler only writes to
/// the DB when the host's `status()` succeeds, so a transient
/// unavailable-host condition leaves the row alone for the next boot
/// to handle.
///
/// Thin wrapper over [`reattach_interactive_sessions_inner`]: the
/// inner function takes a plain `&AppState` plus an emit callback so
/// it can be unit-tested without booting a real Tauri runtime. The
/// `AppHandle` is only used here to (a) borrow the managed `AppState`
/// and (b) wire `app.emit(...)` into the inner reconciler's
/// `OrphanEmitter` slot.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn reattach_interactive_sessions_on_boot(app: AppHandle) {
    let state = app.state::<AppState>();
    let emit_app = app.clone();
    let emit_orphans: OrphanEmitter = Box::new(move |payload: &OrphansDetectedPayload| {
        emit_app
            .emit("interactive://orphans-detected", payload)
            .map_err(|e| e.to_string())
    });
    reattach_interactive_sessions_inner(state.inner(), emit_orphans).await;
}

/// Testable core of the boot reconciler. Takes a borrowed `AppState`
/// (the same managed instance the production entry hands in) plus a
/// callback that emits the `interactive://orphans-detected` payload.
///
/// Splitting this out lets the unit tests in `mod tests` exercise the
/// flag-gate / DB-read-failure / per-workspace host resolution /
/// orphan-fallback / emit branches without constructing a real
/// `AppHandle` (which requires a full Tauri runtime). The behavior
/// is identical to the legacy combined function — see the module docs
/// for the full contract.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub(crate) async fn reattach_interactive_sessions_inner(
    state: &AppState,
    emit_orphans: OrphanEmitter,
) {
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
                if let Err(err) = emit_orphans(&payload) {
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

#[cfg(test)]
mod tests {
    //! Boot-reconciler branch coverage.
    //!
    //! Tests construct an `AppState` directly (the same shape used by
    //! `tray.rs`'s `fresh_state` helper) backed by an on-disk SQLite
    //! file under a tempdir, pre-seed `interactive_hosts` with mocks
    //! so `interactive_host_for` returns deterministic values, and
    //! drive the inner reconciler with a recorded `OrphanEmitter`
    //! closure.
    //!
    //! Branches under test (numbered from Task D1):
    //!  1. flag OFF → early return (no host work).
    //!  2. empty DB + empty known sids → fast-path return.
    //!  3. single workspace, host knows session → row → `detached`.
    //!  4. single workspace, host doesn't know → row → `crashed`.
    //!  5. orphan fallback: no running rows but host has a claudette- sid the DB doesn't.
    //!  6. host resolution failure for one workspace doesn't abort others.
    //!  7. emit-failure path is logged and swallowed.
    //!
    //! Branch 6 of the plan (DB read failure on the running-rows query) is
    //! intentionally NOT exercised: there is no race-free way to construct
    //! a DB that the flag-check `get_app_setting` query can read but the
    //! subsequent `list_running_interactive_sessions` query cannot, without
    //! introducing a fault-injection hook into `Database::open` that lives
    //! purely for this test. The branch is shallow (log + early return)
    //! and the underlying `list_running_interactive_sessions` failure mode
    //! is already covered by the DB-layer's own tests.

    use super::*;
    use async_trait::async_trait;
    use claudette::agent::interactive_host::{
        AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
        InteractiveHost, ScreenSnapshot, SessionId,
    };
    use claudette::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
    use claudette::db::{Database, InteractiveSessionRow};
    use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
    use claudette::plugin_runtime::PluginRegistry;
    use std::path::PathBuf;
    use std::sync::Mutex as StdMutex;
    use tempfile::TempDir;

    /// Spin up a fresh on-disk DB under a tempdir and return both the
    /// tempdir guard (kept by the caller so the file outlives the test)
    /// and the db_path used to construct the AppState. The DB is opened
    /// once here to run migrations; subsequent code paths in the
    /// reconciler re-open the same file.
    fn make_db() -> (TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("claudette.db");
        let db = Database::open(&db_path).unwrap();
        // The interactive_sessions table FKs into workspaces(id); seed a
        // placeholder repository so per-test workspace inserts succeed.
        db.insert_repository(&make_repo("repo-1", "/tmp/repo1", "repo-1"))
            .unwrap();
        (tmp, db_path)
    }

    fn make_app_state(db_path: PathBuf) -> AppState {
        // Match the construction shape used by `tray.rs::fresh_state` and
        // `ipc.rs::fresh_app_state` — a discover against a nonexistent
        // plugin dir yields an empty registry with no Lua/IO cost.
        let plugins = PluginRegistry::discover(std::path::Path::new("/nonexistent"));
        AppState::new(db_path, std::path::PathBuf::from("/tmp"), plugins)
    }

    fn make_repo(id: &str, path: &str, name: &str) -> Repository {
        Repository {
            id: id.into(),
            path: path.into(),
            name: name.into(),
            path_slug: name.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            required_inputs: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo_id: &str, name: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: name.into(),
            branch_name: format!("claudette/{name}"),
            worktree_path: None,
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
            input_values: None,
        }
    }

    fn make_row(sid: &str, ws_id: &str, state: &str) -> InteractiveSessionRow {
        InteractiveSessionRow {
            sid: sid.into(),
            workspace_id: ws_id.into(),
            host_kind: "tmux".into(),
            state: state.into(),
            crash_reason: None,
            created_at: "2026-05-16T00:00:00Z".into(),
            last_attached_at: None,
            last_screen_blob: None,
            claude_flags_json: "[]".into(),
            pid: None,
        }
    }

    /// Drop-in `InteractiveHost` whose `status()` returns a fixed list
    /// and which panics on every other trait method — the reconciler
    /// must not call attach/send_input/etc on the boot path.
    struct ProgrammableHost {
        sessions: Vec<HostSessionSummary>,
    }

    #[async_trait]
    impl InteractiveHost for ProgrammableHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unreachable!("boot reconciler must not ensure_session")
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unreachable!("boot reconciler must not attach")
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unreachable!("boot reconciler must not send_input")
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unreachable!("boot reconciler must not capture_screen")
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unreachable!("boot reconciler must not resize")
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unreachable!("boot reconciler must not detach")
        }
        async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
            unreachable!("boot reconciler must not stop")
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            Ok(HostStatus {
                host_version: "mock".into(),
                sessions: self.sessions.clone(),
            })
        }
    }

    /// Host whose `status()` always errors. Used to assert that one
    /// workspace's host failure doesn't abort the reconciler for other
    /// workspaces.
    struct ErroringHost;

    #[async_trait]
    impl InteractiveHost for ErroringHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unreachable!()
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unreachable!()
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unreachable!()
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unreachable!()
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unreachable!()
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unreachable!()
        }
        async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
            unreachable!()
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            Err(HostError::Unavailable("mock".into()))
        }
    }

    /// Host whose every method panics — used as the negative witness for
    /// the flag-OFF and empty-DB fast paths. Any call into this host
    /// would be a regression in the early-return logic.
    struct PanickyHost;

    #[async_trait]
    impl InteractiveHost for PanickyHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
            unreachable!("flag-OFF / empty-DB path must not touch host")
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            panic!("status must not be called on flag-OFF / empty-DB fast path")
        }
    }

    /// Build a recording `OrphanEmitter` and return a handle to inspect
    /// the captured payloads after the reconciler returns.
    fn recording_emitter() -> (OrphanEmitter, Arc<StdMutex<Vec<Vec<String>>>>) {
        let log: Arc<StdMutex<Vec<Vec<String>>>> = Arc::new(StdMutex::new(Vec::new()));
        let log_clone = Arc::clone(&log);
        let emitter: OrphanEmitter = Box::new(move |payload: &OrphansDetectedPayload| {
            log_clone.lock().unwrap().push(payload.sids.clone());
            Ok(())
        });
        (emitter, log)
    }

    fn failing_emitter() -> OrphanEmitter {
        Box::new(|_| Err("simulated emit failure".to_string()))
    }

    // --- Branch 1: flag OFF early return -----------------------------------

    #[tokio::test]
    async fn flag_off_early_return_does_not_touch_host() {
        // Flag absent (defaults to disabled). Pre-seed a `running` row
        // and register a `PanickyHost` for its workspace — any host call
        // means the early-return failed.
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        db.create_interactive_session(&make_row("claudette-ws1-aaaaaaaa", "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        // Pre-seed a host that panics on any call so a regression
        // bypassing the gate fails loudly.
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::new(PanickyHost) as _);

        let (emitter, log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        // Row is left exactly as inserted: still `running`.
        let row = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "running", "flag-OFF must not reclassify rows");

        // No orphans emitted.
        assert!(log.lock().unwrap().is_empty());
    }

    // --- Branch 2: empty DB fast-path --------------------------------------

    #[tokio::test]
    async fn empty_db_and_known_sids_fast_path_does_not_touch_host() {
        // Flag ON, but the DB has neither running rows nor any
        // historical sids. The fast-path branch must return before any
        // host resolution.
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();

        let state = make_app_state(db_path);
        // Pre-seed PanickyHost just to prove no host is touched; the
        // empty-DB branch returns before any `interactive_host_for` call.
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::new(PanickyHost) as _);

        let (emitter, log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        assert!(
            log.lock().unwrap().is_empty(),
            "empty-DB fast path must not emit",
        );
        // No orphans recorded into AppState either.
        assert!(state.interactive_orphans.read().await.is_empty());
    }

    // --- Branch 3: host knows session → detached ---------------------------

    #[tokio::test]
    async fn single_workspace_host_knows_session_marks_row_detached() {
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let sid = "claudette-ws1-aaaaaaaa";
        db.create_interactive_session(&make_row(sid, "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        state.interactive_hosts.write().await.insert(
            "ws-1".to_string(),
            Arc::new(ProgrammableHost {
                sessions: vec![HostSessionSummary {
                    sid: SessionId(sid.into()),
                    pid: None,
                    running: true,
                }],
            }) as _,
        );

        let (emitter, log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        let row = db.get_interactive_session(sid).unwrap().unwrap();
        assert_eq!(row.state, "detached", "host-knows → detached");
        assert!(row.crash_reason.is_none());
        // No orphans — the host reports exactly the DB-known sid.
        assert!(log.lock().unwrap().is_empty());
    }

    // --- Branch 4: host doesn't know session → crashed ---------------------

    #[tokio::test]
    async fn single_workspace_host_missing_session_marks_row_crashed() {
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let sid = "claudette-ws1-bbbbbbbb";
        db.create_interactive_session(&make_row(sid, "ws-1", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        state.interactive_hosts.write().await.insert(
            "ws-1".to_string(),
            Arc::new(ProgrammableHost { sessions: vec![] }) as _,
        );

        let (emitter, _log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        let row = db.get_interactive_session(sid).unwrap().unwrap();
        assert_eq!(row.state, "crashed", "host-missing → crashed");
        assert_eq!(row.crash_reason.as_deref(), Some("host missing"));
    }

    // --- Branch 5: orphan fallback when no running rows --------------------

    #[tokio::test]
    async fn orphan_fallback_probes_workspace_for_host_and_records_orphans() {
        // No `running` rows, but the DB tracks a historical sid (state =
        // 'crashed') for ws-1 — `list_all_interactive_session_sids` will
        // return it. The fallback should probe ws-1's host, find an
        // unrelated claudette- sid still alive, and record it as an
        // orphan in `AppState::interactive_orphans` plus emit the event.
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let known_sid = "claudette-ws1-knownsid";
        db.create_interactive_session(&make_row(known_sid, "ws-1", "crashed"))
            .unwrap();

        let orphan_sid = "claudette-ws1-orphan11";
        let state = make_app_state(db_path);
        state.interactive_hosts.write().await.insert(
            "ws-1".to_string(),
            Arc::new(ProgrammableHost {
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId(known_sid.into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId(orphan_sid.into()),
                        pid: None,
                        running: true,
                    },
                ],
            }) as _,
        );

        let (emitter, log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        // Orphan got stashed in AppState so `interactive_cleanup_orphans`
        // can stop it without re-resolving the host.
        let orphans = state.interactive_orphans.read().await;
        assert!(
            orphans.contains_key(orphan_sid),
            "orphan sid must be stashed in AppState, got {:?}",
            orphans.keys().collect::<Vec<_>>(),
        );
        assert!(
            !orphans.contains_key(known_sid),
            "DB-known sid must not be flagged as orphan",
        );

        // Emit happened with the orphan payload.
        let emissions = log.lock().unwrap();
        assert_eq!(emissions.len(), 1, "exactly one orphans-detected emission");
        assert_eq!(emissions[0], vec![orphan_sid.to_string()]);
    }

    // --- Branch 7 (plan numbering): per-workspace host failure isolation ---

    #[tokio::test]
    async fn host_resolution_failure_for_one_workspace_does_not_abort_others() {
        // Two workspaces, each with a `running` row. ws-1 has an erroring
        // host (`status()` returns Err); ws-2 has a normal host that
        // knows its session. The reconciler must still reclassify ws-2's
        // row even though ws-1's host errored.
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        db.insert_workspace(&make_workspace("ws-2", "repo-1", "feature"))
            .unwrap();
        let ws1_sid = "claudette-ws1-cccccccc";
        let ws2_sid = "claudette-ws2-dddddddd";
        db.create_interactive_session(&make_row(ws1_sid, "ws-1", "running"))
            .unwrap();
        db.create_interactive_session(&make_row(ws2_sid, "ws-2", "running"))
            .unwrap();

        let state = make_app_state(db_path);
        // ws-1: host status() errors.
        state
            .interactive_hosts
            .write()
            .await
            .insert("ws-1".to_string(), Arc::new(ErroringHost) as _);
        // ws-2: host knows its session.
        state.interactive_hosts.write().await.insert(
            "ws-2".to_string(),
            Arc::new(ProgrammableHost {
                sessions: vec![HostSessionSummary {
                    sid: SessionId(ws2_sid.into()),
                    pid: None,
                    running: true,
                }],
            }) as _,
        );

        let (emitter, _log) = recording_emitter();
        reattach_interactive_sessions_inner(&state, emitter).await;

        // ws-1's row is left as `running` — the host's `status()` errored
        // so `reattach_rows` propagates the error and the row stays
        // unclassified (per `reattach_rows`'s "surface host errors"
        // contract).
        let ws1_row = db.get_interactive_session(ws1_sid).unwrap().unwrap();
        assert_eq!(
            ws1_row.state, "running",
            "ws-1's row must remain `running` because its host errored",
        );

        // ws-2's row was reclassified normally.
        let ws2_row = db.get_interactive_session(ws2_sid).unwrap().unwrap();
        assert_eq!(
            ws2_row.state, "detached",
            "ws-2's row must be reclassified even though ws-1's host failed",
        );
    }

    // --- Branch 8 (plan calls it part of the orphan emit branch): emit failure
    //     path is logged and swallowed. -------------------------------------

    #[tokio::test]
    async fn orphan_emit_failure_is_swallowed_and_orphans_still_recorded() {
        // Even when the emit closure returns Err, the reconciler must
        // still stash the orphan into `AppState::interactive_orphans` so
        // a subsequent `interactive_cleanup_orphans` invocation can find
        // and stop it. The map is populated BEFORE the emit call —
        // confirm that ordering hasn't regressed.
        let (_tmp, db_path) = make_db();
        let db = Database::open(&db_path).unwrap();
        db.set_app_setting("claudeInteractiveEnabled", "true")
            .unwrap();
        db.insert_workspace(&make_workspace("ws-1", "repo-1", "fix-bug"))
            .unwrap();
        let known_sid = "claudette-ws1-knownsid";
        let orphan_sid = "claudette-ws1-orphan99";
        db.create_interactive_session(&make_row(known_sid, "ws-1", "crashed"))
            .unwrap();

        let state = make_app_state(db_path);
        state.interactive_hosts.write().await.insert(
            "ws-1".to_string(),
            Arc::new(ProgrammableHost {
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId(known_sid.into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId(orphan_sid.into()),
                        pid: None,
                        running: true,
                    },
                ],
            }) as _,
        );

        // Failing emitter so the reconciler must log + continue.
        reattach_interactive_sessions_inner(&state, failing_emitter()).await;

        let orphans = state.interactive_orphans.read().await;
        assert!(
            orphans.contains_key(orphan_sid),
            "orphan must be stashed even when the emit closure errored",
        );
    }
}
