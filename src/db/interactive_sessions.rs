//! Interactive (long-lived Claude TUI) session CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use serde::{Deserialize, Serialize};

use super::Database;

/// Persisted row for an interactive Claude session (long-lived TUI host like
/// `tmux` or the in-process sidecar). Mirrors the `interactive_sessions`
/// table 1:1.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractiveSessionRow {
    pub sid: String,
    pub workspace_id: String,
    pub host_kind: String,
    pub state: String,
    pub crash_reason: Option<String>,
    pub created_at: String,
    pub last_attached_at: Option<String>,
    pub last_screen_blob: Option<Vec<u8>>,
    pub claude_flags_json: String,
    pub pid: Option<i64>,
}

impl Database {
    // --- Interactive Sessions ---

    pub fn create_interactive_session(&self, row: &InteractiveSessionRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO interactive_sessions
             (sid, workspace_id, host_kind, state, crash_reason, created_at,
              last_attached_at, last_screen_blob, claude_flags_json, pid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.sid,
                row.workspace_id,
                row.host_kind,
                row.state,
                row.crash_reason,
                row.created_at,
                row.last_attached_at,
                row.last_screen_blob,
                row.claude_flags_json,
                row.pid,
            ],
        )?;
        Ok(())
    }

    pub fn get_interactive_session(
        &self,
        sid: &str,
    ) -> rusqlite::Result<Option<InteractiveSessionRow>> {
        self.conn
            .query_row(
                "SELECT sid, workspace_id, host_kind, state, crash_reason, created_at,
                        last_attached_at, last_screen_blob, claude_flags_json, pid
                 FROM interactive_sessions WHERE sid = ?1",
                params![sid],
                |r| {
                    Ok(InteractiveSessionRow {
                        sid: r.get(0)?,
                        workspace_id: r.get(1)?,
                        host_kind: r.get(2)?,
                        state: r.get(3)?,
                        crash_reason: r.get(4)?,
                        created_at: r.get(5)?,
                        last_attached_at: r.get(6)?,
                        last_screen_blob: r.get(7)?,
                        claude_flags_json: r.get(8)?,
                        pid: r.get(9)?,
                    })
                },
            )
            .optional()
    }

    pub fn list_interactive_sessions_for_workspace(
        &self,
        workspace_id: &str,
    ) -> rusqlite::Result<Vec<InteractiveSessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT sid, workspace_id, host_kind, state, crash_reason, created_at,
                    last_attached_at, last_screen_blob, claude_flags_json, pid
             FROM interactive_sessions WHERE workspace_id = ?1
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |r| {
            Ok(InteractiveSessionRow {
                sid: r.get(0)?,
                workspace_id: r.get(1)?,
                host_kind: r.get(2)?,
                state: r.get(3)?,
                crash_reason: r.get(4)?,
                created_at: r.get(5)?,
                last_attached_at: r.get(6)?,
                last_screen_blob: r.get(7)?,
                claude_flags_json: r.get(8)?,
                pid: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn set_interactive_session_state(
        &self,
        sid: &str,
        state: &str,
        crash_reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE interactive_sessions SET state = ?1, crash_reason = ?2 WHERE sid = ?3",
            params![state, crash_reason, sid],
        )?;
        Ok(())
    }

    pub fn update_interactive_session_screen(
        &self,
        sid: &str,
        blob: &[u8],
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE interactive_sessions SET last_screen_blob = ?1,
             last_attached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE sid = ?2",
            params![blob, sid],
        )?;
        Ok(())
    }

    pub fn delete_interactive_session(&self, sid: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM interactive_sessions WHERE sid = ?1",
            params![sid],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db::test_support::{make_repo, make_workspace};

    fn setup_db_with_named_workspace(ws_id: &str) -> Database {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace(ws_id, "r1", "fix-bug"))
            .unwrap();
        db
    }

    fn make_row(sid: &str, workspace_id: &str) -> InteractiveSessionRow {
        InteractiveSessionRow {
            sid: sid.into(),
            workspace_id: workspace_id.into(),
            host_kind: "sidecar".into(),
            state: "running".into(),
            crash_reason: None,
            created_at: "2026-05-16T00:00:00Z".into(),
            last_attached_at: None,
            last_screen_blob: None,
            claude_flags_json: "[]".into(),
            pid: Some(1234),
        }
    }

    #[test]
    fn interactive_session_create_get_update_delete() {
        let db = setup_db_with_named_workspace("ws-1");

        let row = make_row("claudette-ws1-aaaaaaaa", "ws-1");
        db.create_interactive_session(&row).unwrap();

        let got = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(got.state, "running");
        assert_eq!(got.pid, Some(1234));

        db.set_interactive_session_state("claudette-ws1-aaaaaaaa", "detached", None)
            .unwrap();
        let got2 = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(got2.state, "detached");

        db.update_interactive_session_screen("claudette-ws1-aaaaaaaa", b"\x1b[31mhi\x1b[0m")
            .unwrap();
        let got3 = db
            .get_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap()
            .unwrap();
        assert_eq!(
            got3.last_screen_blob.as_deref(),
            Some(b"\x1b[31mhi\x1b[0m".as_slice())
        );
        // update_interactive_session_screen also stamps last_attached_at.
        assert!(got3.last_attached_at.is_some());

        let listed = db.list_interactive_sessions_for_workspace("ws-1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].sid, "claudette-ws1-aaaaaaaa");

        db.delete_interactive_session("claudette-ws1-aaaaaaaa")
            .unwrap();
        assert!(
            db.get_interactive_session("claudette-ws1-aaaaaaaa")
                .unwrap()
                .is_none()
        );
    }
}
