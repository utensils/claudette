//! Startup lifecycle helpers for interactive (long-lived `claude` TUI) sessions.
//!
//! Claudette persists one row per interactive `claude` session in the
//! `interactive_sessions` table, with a `state` column that tracks
//! whether the session is live (`running`), idle but reattachable
//! (`detached`), or gone (`crashed` / `exited`). The transitions
//! between those states normally run while Claudette is up and
//! talking to its `InteractiveHost`. But when Claudette itself crashes
//! or is force-quit, any rows that were last seen as `running` are
//! frozen in that state — the GUI restarts with stale "active" badges
//! pointing at sessions that may or may not still exist on the host.
//!
//! [`reattach_pending`] is the boot-time reconciler that walks every
//! `running` row, asks the host what it actually has, and rewrites the
//! row's state accordingly:
//!
//! - Host still has the session → `state = 'detached'`. The host is
//!   alive and the session can be reattached by the user; the
//!   sidebar badge (G7) shows a "detached" pip instead of a green
//!   "running" one.
//! - Host doesn't have the session → `state = 'crashed'`,
//!   `crash_reason = "host missing"`. The session is unrecoverable;
//!   the row stays in the listing so the user can clear it.
//!
//! Rows already in `detached`, `crashed`, `exited`, etc. are left
//! alone — the reconciliation is intentionally scoped to "the set of
//! rows whose state can be wrong after a Claudette restart".
//!
//! This is a pure function over a `Database` and an `InteractiveHost`
//! so it can be unit-tested without booting Tauri. The Tauri startup
//! code calls it once per workspace's resolved host after the DB is
//! opened and before the UI is allowed to render the affected
//! sessions.
//!
//! Note: H1 does NOT auto-reattach the running session into the live
//! UI. That requires coordination with the chat panel and turn
//! assembler and lives in a follow-up task; H1's job is just to
//! classify the persisted rows so the badge in the sidebar reflects
//! the truth.

use crate::agent::interactive_host::{InteractiveHost, SessionId};
use crate::db::{Database, InteractiveSessionRow};

/// Reconcile every `running` `interactive_sessions` row against
/// `host`. See module docs for the full transition table.
///
/// Errors from the host's `status()` surface to the caller — there is
/// no sensible way to classify rows without knowing what the host has,
/// so we don't paper over the failure. Per-row DB write errors are
/// logged at WARN and skipped so a single bad row can't poison the
/// rest of the reconciliation.
///
/// The function takes `&Database` and the returned future is not
/// `Send`-friendly because `rusqlite::Connection` is `!Sync`. Callers
/// that need to drive the future from a multi-thread Tokio runtime
/// must `spawn_local` (or hand the work to a `LocalSet` /
/// `spawn_blocking` + `current_thread` runtime). The Tauri-side
/// wiring in `claudette-tauri/src/interactive_lifecycle.rs` handles
/// that for the boot path.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn reattach_pending(
    db: &Database,
    host: &dyn InteractiveHost,
) -> Result<(), ReattachError> {
    let pending = db
        .list_running_interactive_sessions()
        .map_err(ReattachError::Db)?;
    reattach_rows(db, &pending, host).await
}

/// Reconcile a caller-supplied set of `interactive_sessions` rows
/// against `host`. Identical contract to [`reattach_pending`], but the
/// row list is provided by the caller instead of being queried from
/// the DB — useful when the caller has already fetched the rows
/// (typically to avoid opening multiple `Database` connections).
///
/// The caller is responsible for scoping `rows` to rows that should
/// be reconciled. In practice every entry should currently be in
/// `state = 'running'`; rows in other states will still be rewritten,
/// so don't pass them in unless that's what you want.
///
/// When `rows` is empty this returns `Ok(())` without calling
/// `host.status()` — matches the no-op fast path in `reattach_pending`
/// and means callers can pass an empty workspace group cheaply.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn reattach_rows(
    db: &Database,
    rows: &[InteractiveSessionRow],
    host: &dyn InteractiveHost,
) -> Result<(), ReattachError> {
    if rows.is_empty() {
        return Ok(());
    }

    let status = host.status().await.map_err(ReattachError::Host)?;
    // Collect the host's live session ids into a quick-lookup set. The
    // host can report sessions with `running = false` if it is
    // tracking ones that exited but hasn't reaped yet; treat those as
    // "host missing" too — the session is no longer attachable.
    let alive: std::collections::HashSet<&str> = status
        .sessions
        .iter()
        .filter(|s| s.running)
        .map(|s| s.sid.as_str())
        .collect();

    for row in rows {
        let sid = row.sid.as_str();
        let (next_state, crash_reason) = if alive.contains(sid) {
            ("detached", None)
        } else {
            ("crashed", Some("host missing"))
        };
        if let Err(err) = db.set_interactive_session_state(sid, next_state, crash_reason) {
            tracing::warn!(
                target: "claudette::interactive",
                sid = %sid,
                error = %err,
                next_state,
                "failed to reclassify interactive session on startup; skipping",
            );
        }
    }

    Ok(())
}

/// Compute the set of `claudette-` sessions the host knows about but
/// the DB does NOT — i.e. sessions left over from a previous Claudette
/// process that crashed before it could record them (or before it
/// could mark a now-orphaned row as torn down). These are returned to
/// the caller so the UI can surface a one-shot "Clean up" prompt and
/// invoke [`InteractiveHost::stop`] on each via the Tauri
/// `interactive_cleanup_orphans` command.
///
/// The filter is intentionally narrow: only sessions whose sid starts
/// with the `claudette-` prefix are considered. The host may be
/// hosting unrelated tmux sessions for the user (or unrelated sidecar
/// sessions from another tool sharing the socket), and we must never
/// stop those.
///
/// `db_known_sids` is the full set of sids the DB currently tracks for
/// this host — typically the union of every state. The caller is
/// responsible for assembling this list (usually by snapshotting all
/// `interactive_sessions` rows). Passing only `running` sids would
/// incorrectly flag valid `detached` / `crashed` rows as orphans.
///
/// Errors from `host.status()` surface to the caller — there is no
/// safe default behavior when the host is unreachable (we don't want
/// to claim "no orphans" if we couldn't actually look).
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn detect_orphans(
    db_known_sids: &[String],
    host: &dyn InteractiveHost,
) -> Result<Vec<SessionId>, ReattachError> {
    let status = host.status().await.map_err(ReattachError::Host)?;
    let db_set: std::collections::HashSet<&str> =
        db_known_sids.iter().map(|s| s.as_str()).collect();
    let orphans = status
        .sessions
        .iter()
        .filter(|s| s.sid.as_str().starts_with("claudette-") && !db_set.contains(s.sid.as_str()))
        .map(|s| s.sid.clone())
        .collect();
    Ok(orphans)
}

/// Errors returned by [`reattach_pending`].
#[derive(Debug, thiserror::Error)]
pub enum ReattachError {
    /// Reading the list of pending sessions failed.
    #[error("database error: {0}")]
    Db(rusqlite::Error),
    /// Calling `status()` on the host failed.
    #[error("host error: {0}")]
    Host(#[from] crate::agent::interactive_host::HostError),
}

/// Gracefully stop every interactive session in `rows` against `host`.
///
/// Used by the workspace archive / delete code paths to tear down the
/// HOST side of an interactive session BEFORE the `interactive_sessions`
/// row is removed by `ON DELETE CASCADE`. Without this, a workspace
/// delete would orphan a live tmux session / sidecar tab — Claudette
/// would no longer track it, but it would keep running.
///
/// Failures from individual `host.stop` calls are logged at WARN and
/// skipped. We do NOT propagate them: the user-facing operation
/// (archive / delete) must still complete even if one host session
/// can't be reached (e.g. tmux server already gone, sidecar socket
/// closed). Cascading the failure would leave the user unable to clear
/// a workspace whose host has already crashed, which is exactly the
/// case where they need the cleanup most.
///
/// Pure function over a host trait so it can be unit-tested without
/// booting Tauri — see the `stop_sessions_calls_host_stop_for_each`
/// test below for the MockHost pattern.
#[tracing::instrument(level = "info", target = "claudette::interactive", skip_all)]
pub async fn stop_sessions_for_workspace(
    rows: &[crate::db::InteractiveSessionRow],
    host: &dyn crate::agent::interactive_host::InteractiveHost,
) {
    use crate::agent::interactive_host::SessionId;
    use crate::agent::interactive_protocol::StopMode;

    for row in rows {
        // Skip rows we already know are dead — there's nothing on the
        // host side to stop and the next-state DB cascade will clean
        // them up. "crashed" / "exited" / "stopped" rows still get the
        // cascade.
        if row.state == "crashed" || row.state == "exited" || row.state == "stopped" {
            continue;
        }
        let sid = SessionId(row.sid.clone());
        if let Err(err) = host.stop(&sid, StopMode::Graceful).await {
            tracing::warn!(
                target: "claudette::interactive",
                sid = %row.sid,
                workspace_id = %row.workspace_id,
                state = %row.state,
                error = %err,
                "failed to gracefully stop interactive session during workspace teardown; \
                 continuing so workspace delete/archive can proceed",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::interactive_host::{
        AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
        InteractiveHost, ScreenSnapshot, SessionId,
    };
    use crate::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
    use crate::db::test_support::{make_repo, make_workspace};
    use crate::db::{Database, InteractiveSessionRow};
    use async_trait::async_trait;

    fn insert_test_workspace(db: &Database, ws_id: &str) {
        // The interactive_sessions table FKs into workspaces(id), so the
        // test row needs a real workspace — and every workspace requires
        // an owning repository. Seed both via the shared test_support
        // helpers so the fixture stays in lockstep with the production
        // schema.
        db.insert_repository(&make_repo("repo-1", "/tmp/repo1", "repo-1"))
            .ok(); // ignore duplicate-repo error on re-seed
        db.insert_workspace(&make_workspace(ws_id, "repo-1", "fix-bug"))
            .unwrap();
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

    /// Mock host whose only meaningful method is `status()`. Every
    /// other trait method panics — `reattach_pending` must never call
    /// them, and a regression that does call them should fail loudly
    /// rather than silently corrupt state.
    struct MockHost {
        status_response: HostStatus,
    }

    #[async_trait]
    impl InteractiveHost for MockHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unimplemented!("reattach_pending must not call ensure_session")
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unimplemented!("reattach_pending must not call attach")
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unimplemented!("reattach_pending must not call send_input")
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unimplemented!("reattach_pending must not call capture_screen")
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unimplemented!("reattach_pending must not call resize")
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unimplemented!("reattach_pending must not call detach")
        }
        async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
            unimplemented!("reattach_pending must not call stop")
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            Ok(self.status_response.clone())
        }
    }

    #[tokio::test]
    async fn reattach_on_startup_classifies_rows() {
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");

        // Seed three rows: two in "running" (one of which the host
        // still has, one it doesn't), and one already "detached" that
        // must be left untouched.
        for (sid, state) in [
            ("claudette-ws1-aaaaaaaa", "running"),
            ("claudette-ws1-bbbbbbbb", "running"),
            ("claudette-ws1-cccccccc", "detached"),
        ] {
            db.create_interactive_session(&make_row(sid, "ws-1", state))
                .unwrap();
        }

        // Host knows about A and C only — B will be classified as
        // crashed even though we don't include it in the host's list.
        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-cccccccc".into()),
                        pid: None,
                        running: true,
                    },
                ],
            },
        };

        reattach_pending(&db, &host).await.unwrap();

        let a = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(a.state, "detached", "A: still on host → detached");
        assert!(a.crash_reason.is_none());

        let b = db
            .get_interactive_session("claudette-ws1-bbbbbbbb")
            .unwrap()
            .unwrap();
        assert_eq!(b.state, "crashed", "B: missing on host → crashed");
        assert_eq!(b.crash_reason.as_deref(), Some("host missing"));

        let c = db
            .get_interactive_session("claudette-ws1-cccccccc")
            .unwrap()
            .unwrap();
        assert_eq!(c.state, "detached", "C: already detached, left alone");
        assert!(c.crash_reason.is_none());
    }

    #[tokio::test]
    async fn reattach_pending_treats_not_running_host_summaries_as_missing() {
        // The host can report a session with `running = false` while it
        // is mid-reap; those count as "host missing" for the purposes
        // of the DB reconciliation because the user can no longer
        // attach to them.
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");
        db.create_interactive_session(&make_row("claudette-ws1-zzzzzzzz", "ws-1", "running"))
            .unwrap();

        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![HostSessionSummary {
                    sid: SessionId("claudette-ws1-zzzzzzzz".into()),
                    pid: None,
                    running: false,
                }],
            },
        };

        reattach_pending(&db, &host).await.unwrap();

        let row = db
            .get_interactive_session("claudette-ws1-zzzzzzzz")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "crashed");
        assert_eq!(row.crash_reason.as_deref(), Some("host missing"));
    }

    #[tokio::test]
    async fn reattach_pending_is_noop_when_no_running_rows() {
        // No DB rows means no host call: this contract matters because
        // booting against a non-functional host (no tmux, sidecar
        // binary missing) shouldn't error out the boot path when there
        // is nothing to reconcile.
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");
        db.create_interactive_session(&make_row("claudette-ws1-exited", "ws-1", "exited"))
            .unwrap();

        struct FailingHost;
        #[async_trait]
        impl InteractiveHost for FailingHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                panic!("status must not be called when no running rows exist")
            }
        }

        reattach_pending(&db, &FailingHost).await.unwrap();

        // Pre-existing non-running row is untouched.
        let row = db
            .get_interactive_session("claudette-ws1-exited")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "exited");
    }

    #[tokio::test]
    async fn reattach_rows_classifies_provided_rows_without_db_query() {
        // reattach_rows operates on caller-supplied rows; it must NOT
        // call list_running_interactive_sessions itself. To prove that,
        // seed the DB with a row that has state = 'detached' (so the
        // list query would return zero "running" rows), pass that row
        // in explicitly, and verify it still gets classified.
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");

        // Seed two rows in 'detached' so list_running_interactive_sessions
        // returns an empty list; pass them in to reattach_rows directly.
        let row_a = make_row("claudette-ws1-aaaaaaaa", "ws-1", "detached");
        let row_b = make_row("claudette-ws1-bbbbbbbb", "ws-1", "detached");
        db.create_interactive_session(&row_a).unwrap();
        db.create_interactive_session(&row_b).unwrap();

        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![HostSessionSummary {
                    sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                    pid: None,
                    running: true,
                }],
            },
        };

        reattach_rows(&db, &[row_a, row_b], &host).await.unwrap();

        // A was reported by host as running → detached (unchanged label,
        // but the call path proves the row was processed).
        let a = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(a.state, "detached");
        assert!(a.crash_reason.is_none());

        // B is not on the host → crashed, host missing.
        let b = db
            .get_interactive_session("claudette-ws1-bbbbbbbb")
            .unwrap()
            .unwrap();
        assert_eq!(b.state, "crashed");
        assert_eq!(b.crash_reason.as_deref(), Some("host missing"));
    }

    #[tokio::test]
    async fn reattach_rows_is_noop_when_rows_empty() {
        // Empty row slice must not call host.status(). This is the
        // contract the boot reconciler relies on when a workspace
        // group ends up empty: passing it in shouldn't spin up the
        // sidecar.
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");

        struct PanickyHost;
        #[async_trait]
        impl InteractiveHost for PanickyHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                panic!("status must not be called when rows is empty")
            }
        }

        reattach_rows(&db, &[], &PanickyHost).await.unwrap();
    }

    #[tokio::test]
    async fn reattach_rows_surfaces_host_status_errors() {
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");
        let row = make_row("claudette-ws1-aaaaaaaa", "ws-1", "running");
        db.create_interactive_session(&row).unwrap();

        struct ErroringHost;
        #[async_trait]
        impl InteractiveHost for ErroringHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                Err(HostError::Unavailable("mock".into()))
            }
        }

        let err = reattach_rows(&db, &[row], &ErroringHost).await.unwrap_err();
        assert!(
            matches!(err, ReattachError::Host(_)),
            "expected ReattachError::Host, got {err:?}",
        );

        // Row is untouched — we don't reclassify when we couldn't
        // reach the host to ask.
        let persisted = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(persisted.state, "running");
    }

    #[tokio::test]
    async fn reattach_pending_surfaces_host_status_errors() {
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");
        db.create_interactive_session(&make_row("claudette-ws1-aaaaaaaa", "ws-1", "running"))
            .unwrap();

        struct ErroringHost;
        #[async_trait]
        impl InteractiveHost for ErroringHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                Err(HostError::Unavailable("mock".into()))
            }
        }

        let err = reattach_pending(&db, &ErroringHost).await.unwrap_err();
        assert!(
            matches!(err, ReattachError::Host(_)),
            "expected ReattachError::Host, got {err:?}",
        );

        // Row is untouched — we don't reclassify when we couldn't
        // reach the host to ask.
        let row = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "running");
    }

    // ----- detect_orphans --------------------------------------------------
    //
    // Orphan detection is a pure host.status() consumer; we reuse MockHost
    // from the reattach tests to construct a known status response.

    #[tokio::test]
    async fn detect_orphans_returns_host_sessions_missing_from_db() {
        // DB tracks A; host has A + B + C (all claudette- prefixed).
        // → B and C are orphans.
        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-bbbbbbbb".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-cccccccc".into()),
                        pid: None,
                        running: true,
                    },
                ],
            },
        };

        let db_known = vec!["claudette-ws1-aaaaaaaa".to_string()];
        let orphans = detect_orphans(&db_known, &host).await.unwrap();

        let orphan_strs: Vec<&str> = orphans.iter().map(|s| s.as_str()).collect();
        assert_eq!(
            orphan_strs.len(),
            2,
            "expected exactly two orphans, got {orphan_strs:?}",
        );
        assert!(orphan_strs.contains(&"claudette-ws1-bbbbbbbb"));
        assert!(orphan_strs.contains(&"claudette-ws1-cccccccc"));
        assert!(
            !orphan_strs.contains(&"claudette-ws1-aaaaaaaa"),
            "DB-known sid must not be reported as orphan",
        );
    }

    #[tokio::test]
    async fn detect_orphans_ignores_non_claudette_prefixed_sessions() {
        // Host hosts a user-owned tmux session ("dev", "scratch") AND a
        // legit DB-tracked claudette session. None of those user sessions
        // count as orphans — Claudette must never kill a session it
        // didn't create.
        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId("dev".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("scratch".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                        pid: None,
                        running: true,
                    },
                ],
            },
        };

        let db_known = vec!["claudette-ws1-aaaaaaaa".to_string()];
        let orphans = detect_orphans(&db_known, &host).await.unwrap();

        assert!(
            orphans.is_empty(),
            "non-claudette sessions must never appear as orphans; got {:?}",
            orphans.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        );
    }

    #[tokio::test]
    async fn detect_orphans_with_empty_db_returns_all_claudette_sessions() {
        // Cold start with a stale tmux server: DB has nothing yet, every
        // claudette- session on the host is an orphan.
        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-bbbbbbbb".into()),
                        pid: None,
                        running: true,
                    },
                ],
            },
        };

        let orphans = detect_orphans(&[], &host).await.unwrap();
        let orphan_strs: Vec<&str> = orphans.iter().map(|s| s.as_str()).collect();
        assert_eq!(orphan_strs.len(), 2);
        assert!(orphan_strs.contains(&"claudette-ws1-aaaaaaaa"));
        assert!(orphan_strs.contains(&"claudette-ws1-bbbbbbbb"));
    }

    #[tokio::test]
    async fn detect_orphans_returns_empty_when_db_covers_host() {
        // Every host session is tracked → no orphans.
        let host = MockHost {
            status_response: HostStatus {
                host_version: "mock".into(),
                sessions: vec![
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-aaaaaaaa".into()),
                        pid: None,
                        running: true,
                    },
                    HostSessionSummary {
                        sid: SessionId("claudette-ws1-bbbbbbbb".into()),
                        pid: None,
                        running: true,
                    },
                ],
            },
        };

        let db_known = vec![
            "claudette-ws1-aaaaaaaa".to_string(),
            "claudette-ws1-bbbbbbbb".to_string(),
        ];
        let orphans = detect_orphans(&db_known, &host).await.unwrap();
        assert!(orphans.is_empty());
    }

    #[tokio::test]
    async fn detect_orphans_surfaces_host_status_errors() {
        struct ErroringHost;
        #[async_trait]
        impl InteractiveHost for ErroringHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                Err(HostError::Unavailable("mock".into()))
            }
        }

        let err = detect_orphans(&[], &ErroringHost).await.unwrap_err();
        assert!(
            matches!(err, ReattachError::Host(_)),
            "expected ReattachError::Host, got {err:?}",
        );
    }

    // ----- stop_sessions_for_workspace -----------------------------------
    //
    // The MockHost below tracks every `stop` call (sid + mode) so the
    // tests can assert exact graceful-shutdown ordering. Every other
    // trait method panics because workspace teardown should never need
    // to attach, send input, capture screen, etc. — only `stop` is
    // valid on this path.

    struct StopTrackingHost {
        stops: Mutex<Vec<(String, StopMode)>>,
        /// When `Some(sid)`, the matching `stop` call returns Err
        /// instead of Ok, so we can assert that one failure doesn't
        /// poison the rest of the batch.
        fail_for_sid: Option<String>,
    }

    use std::sync::Mutex;

    impl StopTrackingHost {
        fn new() -> Self {
            Self {
                stops: Mutex::new(Vec::new()),
                fail_for_sid: None,
            }
        }

        fn with_failure_for(sid: &str) -> Self {
            Self {
                stops: Mutex::new(Vec::new()),
                fail_for_sid: Some(sid.into()),
            }
        }

        fn stopped_sids(&self) -> Vec<String> {
            self.stops
                .lock()
                .unwrap()
                .iter()
                .map(|(s, _)| s.clone())
                .collect()
        }
    }

    #[async_trait]
    impl InteractiveHost for StopTrackingHost {
        async fn ensure_session(
            &self,
            _sid: &SessionId,
            _spec: &SessionSpec,
        ) -> Result<HostHandle, HostError> {
            unimplemented!("stop_sessions_for_workspace must not call ensure_session")
        }
        async fn attach(&self, _sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
            unimplemented!("stop_sessions_for_workspace must not call attach")
        }
        async fn send_input(
            &self,
            _sid: &SessionId,
            _payload: InputPayload,
        ) -> Result<(), HostError> {
            unimplemented!("stop_sessions_for_workspace must not call send_input")
        }
        async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
            unimplemented!("stop_sessions_for_workspace must not call capture_screen")
        }
        async fn resize(&self, _sid: &SessionId, _rows: u16, _cols: u16) -> Result<(), HostError> {
            unimplemented!("stop_sessions_for_workspace must not call resize")
        }
        async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
            unimplemented!("stop_sessions_for_workspace must not call detach")
        }
        async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
            self.stops.lock().unwrap().push((sid.0.clone(), mode));
            if let Some(ref fail) = self.fail_for_sid
                && fail == &sid.0
            {
                return Err(HostError::Unavailable("mock stop failure".into()));
            }
            Ok(())
        }
        async fn status(&self) -> Result<HostStatus, HostError> {
            unimplemented!("stop_sessions_for_workspace must not call status")
        }
    }

    #[tokio::test]
    async fn stop_sessions_calls_host_stop_for_each_live_row() {
        let host = StopTrackingHost::new();
        let rows = vec![
            make_row("claudette-ws1-aaaaaaaa", "ws-1", "running"),
            make_row("claudette-ws1-bbbbbbbb", "ws-1", "detached"),
        ];

        stop_sessions_for_workspace(&rows, &host).await;

        let stops = host.stops.lock().unwrap().clone();
        assert_eq!(stops.len(), 2, "both running+detached rows must be stopped");
        assert_eq!(stops[0].0, "claudette-ws1-aaaaaaaa");
        assert_eq!(stops[0].1, StopMode::Graceful);
        assert_eq!(stops[1].0, "claudette-ws1-bbbbbbbb");
        assert_eq!(stops[1].1, StopMode::Graceful);
    }

    #[tokio::test]
    async fn stop_sessions_skips_already_dead_rows() {
        // Sessions in `crashed`, `exited`, or `stopped` have no live host
        // counterpart; calling stop on them risks a NotFound from the
        // host. The DB cascade still removes the row when the workspace
        // goes away.
        let host = StopTrackingHost::new();
        let rows = vec![
            make_row("claudette-ws1-crashed1", "ws-1", "crashed"),
            make_row("claudette-ws1-exited11", "ws-1", "exited"),
            make_row("claudette-ws1-stopped1", "ws-1", "stopped"),
            make_row("claudette-ws1-runninga", "ws-1", "running"),
        ];

        stop_sessions_for_workspace(&rows, &host).await;

        let stopped = host.stopped_sids();
        assert_eq!(
            stopped,
            vec!["claudette-ws1-runninga".to_string()],
            "only the running row should reach host.stop",
        );
    }

    #[tokio::test]
    async fn stop_sessions_continues_after_per_row_host_failure() {
        // The user-facing operation (archive / delete) must still
        // complete when one host.stop call errors out, so the batch
        // keeps going and the surviving sessions get their graceful
        // shutdown.
        let host = StopTrackingHost::with_failure_for("claudette-ws1-bbbbbbbb");
        let rows = vec![
            make_row("claudette-ws1-aaaaaaaa", "ws-1", "running"),
            make_row("claudette-ws1-bbbbbbbb", "ws-1", "running"),
            make_row("claudette-ws1-cccccccc", "ws-1", "detached"),
        ];

        stop_sessions_for_workspace(&rows, &host).await;

        let stopped = host.stopped_sids();
        assert_eq!(
            stopped,
            vec![
                "claudette-ws1-aaaaaaaa".to_string(),
                "claudette-ws1-bbbbbbbb".to_string(),
                "claudette-ws1-cccccccc".to_string(),
            ],
            "host.stop must be attempted for every live row even when one fails",
        );
    }

    #[tokio::test]
    async fn stop_sessions_is_noop_for_empty_rows() {
        // Empty row slice must not call any host method. Mirrors the
        // boot-reconciler contract: workspaces with no interactive
        // sessions shouldn't spin up the host at teardown time.
        struct PanickyHost;
        #[async_trait]
        impl InteractiveHost for PanickyHost {
            async fn ensure_session(
                &self,
                _sid: &SessionId,
                _spec: &SessionSpec,
            ) -> Result<HostHandle, HostError> {
                unimplemented!()
            }
            async fn attach(
                &self,
                _sid: &SessionId,
            ) -> Result<(AttachId, AttachStream), HostError> {
                unimplemented!()
            }
            async fn send_input(
                &self,
                _sid: &SessionId,
                _payload: InputPayload,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn capture_screen(&self, _sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
                unimplemented!()
            }
            async fn resize(
                &self,
                _sid: &SessionId,
                _rows: u16,
                _cols: u16,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn detach(
                &self,
                _sid: &SessionId,
                _attach_id: AttachId,
            ) -> Result<(), HostError> {
                unimplemented!()
            }
            async fn stop(&self, _sid: &SessionId, _mode: StopMode) -> Result<(), HostError> {
                panic!("stop must not be called when rows is empty")
            }
            async fn status(&self) -> Result<HostStatus, HostError> {
                unimplemented!()
            }
        }

        stop_sessions_for_workspace(&[], &PanickyHost).await;
    }

    // ----- End-to-end: workspace delete tears down interactive sessions ----
    //
    // This is the H2 acceptance test from the plan: insert an
    // interactive_sessions row, call the workspace teardown helper, and
    // assert (a) host.stop was called for the session and (b) the row is
    // gone from the DB after the cascade. We exercise the lib-level
    // helper plus a manual cascade-trigger (`delete_workspace_with_summary`)
    // rather than the Tauri command, since the lib crate cannot depend
    // on the Tauri command surface.

    #[tokio::test]
    async fn workspace_delete_stops_sessions_then_cascade_removes_row() {
        let db = Database::open_in_memory().unwrap();
        insert_test_workspace(&db, "ws-1");

        // Seed two live interactive sessions and one crashed one. After
        // workspace teardown we expect:
        //   - host.stop called for the two live sessions, NOT the crashed one
        //   - all three rows gone from the DB (cascade removes everything)
        db.create_interactive_session(&make_row("claudette-ws1-running1", "ws-1", "running"))
            .unwrap();
        db.create_interactive_session(&make_row("claudette-ws1-detach1", "ws-1", "detached"))
            .unwrap();
        db.create_interactive_session(&make_row("claudette-ws1-crashe1", "ws-1", "crashed"))
            .unwrap();

        // Step 1: enumerate sessions, stop hosts (mimics the command path).
        let rows = db.list_interactive_sessions_for_workspace("ws-1").unwrap();
        assert_eq!(rows.len(), 3, "all three rows present before teardown");

        let host = StopTrackingHost::new();
        stop_sessions_for_workspace(&rows, &host).await;

        let stopped = host.stopped_sids();
        // Order is created_at DESC from the list query, so most-recently
        // created comes first. The fixture sets created_at to the same
        // value, so we just assert membership.
        assert_eq!(stopped.len(), 2, "two live sessions stopped");
        assert!(stopped.contains(&"claudette-ws1-running1".to_string()));
        assert!(stopped.contains(&"claudette-ws1-detach1".to_string()));
        assert!(
            !stopped.contains(&"claudette-ws1-crashe1".to_string()),
            "crashed row must not trigger host.stop",
        );

        // Step 2: cascade-delete the workspace.
        db.delete_workspace_with_summary("ws-1").unwrap();

        // The interactive_sessions rows must be gone via FK ON DELETE
        // CASCADE — proves the host stop happened BEFORE the cascade
        // (otherwise we'd have no rows to enumerate above).
        for sid in [
            "claudette-ws1-running1",
            "claudette-ws1-detach1",
            "claudette-ws1-crashe1",
        ] {
            assert!(
                db.get_interactive_session(sid).unwrap().is_none(),
                "row {sid} should be cascade-deleted with the workspace",
            );
        }
    }
}
