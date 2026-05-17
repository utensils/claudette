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

use crate::agent::interactive_host::InteractiveHost;
use crate::db::Database;

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
    if pending.is_empty() {
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

    for row in &pending {
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
}
