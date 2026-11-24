use crate::model::{ChatSession, SubagentRun, SubagentRunUpdate};
use rusqlite::{OptionalExtension, Row, Transaction, TransactionBehavior, params};

use super::Database;

/// A host can read a database used by another desktop or standalone server.
/// Only its own live process can attest that a stored observation is current.
fn observer_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

const COLUMNS: &str = "session_id,harness,run_id,parent_run_id,assignment,status,summary,tool_use_id,report_kind,report_summary,updated_at,revision,
    (SELECT linked_session_id FROM team_agent_tabs WHERE subagent_runs.harness='claude'
        AND parent_session_id=subagent_runs.session_id AND team_agent_tabs.tool_use_id=subagent_runs.tool_use_id)";

fn read(row: &Row<'_>) -> rusqlite::Result<SubagentRun> {
    Ok(SubagentRun {
        session_id: row.get(0)?,
        native: SubagentRunUpdate {
            harness: row.get(1)?,
            run_id: row.get(2)?,
            parent_run_id: row.get(3)?,
            assignment: row.get(4)?,
            status: row.get(5)?,
            summary: row.get(6)?,
            tool_use_id: row.get(7)?,
        },
        linked_session_id: row.get(12)?,
        report_kind: row.get(8)?,
        report_summary: row.get(9)?,
        updated_at: row.get(10)?,
        revision: row.get(11)?,
    })
}

fn terminal(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "stopped"))
}

impl Database {
    /// Claim a Claude team launch and create its tab together. The mapping
    /// survives either ordering of the launch callback and native task events.
    /// A replay (even after the tab was deleted) must not launch another worker.
    pub fn create_team_agent_tab(
        &self,
        parent_session_id: &str,
        tool_use_id: &str,
    ) -> rusqlite::Result<Option<(ChatSession, Vec<SubagentRun>)>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let claimed = tx.execute(
            "INSERT INTO team_agent_tabs(parent_session_id,tool_use_id) VALUES(?1,?2)
             ON CONFLICT(parent_session_id,tool_use_id) DO NOTHING",
            params![parent_session_id, tool_use_id],
        )?;
        if claimed == 0 {
            return Ok(None);
        }
        let parent = self
            .get_chat_session(parent_session_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let child = self.create_chat_session(&parent.workspace_id)?;
        tx.execute(
            "UPDATE team_agent_tabs SET linked_session_id=?3 WHERE parent_session_id=?1 AND tool_use_id=?2",
            params![parent_session_id, tool_use_id, child.id],
        )?;
        let changed = {
            let mut stmt = tx.prepare(&format!(
                "UPDATE subagent_runs SET revision=revision+1, updated_at=?3
                 WHERE session_id=?1 AND tool_use_id=?2 AND harness='claude' RETURNING {COLUMNS}"
            ))?;
            stmt.query_map(params![parent_session_id, tool_use_id, now()], read)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(Some((child, changed)))
    }

    pub fn list_subagent_runs(&self, session: &str) -> rusqlite::Result<Vec<SubagentRun>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {COLUMNS}, observer_id FROM subagent_runs WHERE session_id=?1 ORDER BY rowid"
        ))?;
        stmt.query_map([session], |r| {
            let mut row = read(r)?;
            if r.get::<_, String>(13)? != observer_id() && !terminal(row.native.status.as_deref()) {
                row.native.status = Some("disconnected".into());
            }
            Ok(row)
        })?
        .collect()
    }

    /// Return only changed snapshots. Take the write lock before reading so a
    /// simultaneous MCP report and native event cannot overwrite each other.
    pub fn observe_subagent(
        &self,
        session: &str,
        update: &SubagentRunUpdate,
    ) -> rusqlite::Result<Option<SubagentRun>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let sql = format!(
            "SELECT {COLUMNS}, observer_id FROM subagent_runs
            WHERE session_id=?1 AND harness=?2 AND run_id=?3"
        );
        let current = tx
            .query_row(&sql, params![session, update.harness, update.run_id], |r| {
                Ok((read(r)?, r.get::<_, String>(13)?))
            })
            .optional()?;
        if current.is_none() && update.status.as_deref() == Some("disconnected") {
            return Ok(None);
        }
        let mut next = current
            .as_ref()
            .map(|(row, _)| row.native.clone())
            .unwrap_or_default();
        next.harness.clone_from(&update.harness);
        next.run_id.clone_from(&update.run_id);
        if let Some(value) = &update.parent_run_id {
            next.parent_run_id = Some(value.clone());
        }
        if let Some(value) = &update.tool_use_id {
            next.tool_use_id = Some(value.clone());
        }
        if let Some(value) = &update.assignment {
            next.assignment = Some(value.clone());
        }
        // A replayed start must never reopen a finished worker. Only an explicit
        // native resume operation may start work again under the same identity.
        let resumed = update.status.as_deref() == Some("resumed");
        if resumed
            || update.status.is_none()
            || !terminal(next.status.as_deref())
            || terminal(update.status.as_deref())
        {
            if let Some(status) = &update.status {
                next.status = Some(if resumed {
                    "running".into()
                } else {
                    status.clone()
                });
            }
            if let Some(value) = &update.summary {
                next.summary = Some(value.clone());
            }
        }
        if current
            .as_ref()
            .is_some_and(|(row, owner)| row.native == next && owner == observer_id())
        {
            return Ok(None);
        }
        let sql = format!("INSERT INTO subagent_runs(session_id,harness,run_id,parent_run_id,assignment,status,summary,tool_use_id,updated_at,revision,observer_id,launch_message_id)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,(SELECT id FROM chat_messages WHERE chat_session_id=?1 AND role='user' ORDER BY rowid DESC LIMIT 1)) ON CONFLICT(session_id,harness,run_id) DO UPDATE SET
            observer_id=excluded.observer_id,parent_run_id=excluded.parent_run_id,assignment=excluded.assignment,status=excluded.status,summary=excluded.summary,
            tool_use_id=excluded.tool_use_id,updated_at=excluded.updated_at,revision=revision+1 RETURNING {COLUMNS}");
        let row = tx.query_row(
            &sql,
            params![
                session,
                next.harness,
                next.run_id,
                next.parent_run_id,
                next.assignment,
                next.status,
                next.summary,
                next.tool_use_id,
                now(),
                observer_id()
            ],
            read,
        )?;
        tx.commit()?;
        Ok(Some(row))
    }

    pub fn report_subagent_progress(
        &self,
        session: &str,
        harness: &str,
        run: &str,
        kind: &str,
        summary: &str,
    ) -> Result<Option<SubagentRun>, String> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let key = params![session, harness, run];
        let current = tx.query_row(&format!("SELECT {COLUMNS} FROM subagent_runs WHERE session_id=?1 AND harness=?2 AND run_id=?3"),key,read)
            .optional().map_err(|e|e.to_string())?.ok_or("Unknown run in this chat and harness")?;
        if current.report_kind.as_deref() == Some(kind)
            && current.report_summary.as_deref() == Some(summary)
        {
            return Ok(None);
        }
        let sql = format!("UPDATE subagent_runs SET report_kind=?4,report_summary=?5,updated_at=?6,revision=revision+1
            WHERE session_id=?1 AND harness=?2 AND run_id=?3 RETURNING {COLUMNS}");
        let row = tx
            .query_row(
                &sql,
                params![session, harness, run, kind, summary, now()],
                read,
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some(row))
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn teammate_tab_tracks_the_launch_scope_in_either_event_order() {
        let db = crate::db::test_support::setup_db_with_workspace();
        let parent = db.default_session_id_for_workspace("w1").unwrap().unwrap();
        let another = db.create_chat_session("w1").unwrap();
        let mut run = SubagentRunUpdate {
            harness: "claude".into(),
            run_id: "worker".into(),
            tool_use_id: Some("launch".into()),
            ..Default::default()
        };

        let first = db.observe_subagent(&parent, &run).unwrap().unwrap();
        assert!(first.linked_session_id.is_none());
        let (tab, changed) = db
            .create_team_agent_tab(&parent, "launch")
            .unwrap()
            .unwrap();
        assert_eq!(changed.len(), 1);
        assert!(changed[0].revision > first.revision);
        assert_eq!(
            changed[0].linked_session_id.as_deref(),
            Some(tab.id.as_str())
        );
        assert!(
            db.create_team_agent_tab(&parent, "launch")
                .unwrap()
                .is_none()
        );

        let (other_tab, empty) = db
            .create_team_agent_tab(&another.id, "launch")
            .unwrap()
            .unwrap();
        assert!(empty.is_empty());
        assert_ne!(other_tab.id, tab.id);
        let late = db.observe_subagent(&another.id, &run).unwrap().unwrap();
        assert_eq!(
            late.linked_session_id.as_deref(),
            Some(other_tab.id.as_str())
        );
        assert_eq!(db.list_subagent_runs(&another.id).unwrap(), vec![late]);

        run.harness = "codex".into();
        assert!(
            db.observe_subagent(&parent, &run)
                .unwrap()
                .unwrap()
                .linked_session_id
                .is_none()
        );
        db.conn
            .execute("DELETE FROM chat_sessions WHERE id=?1", [&tab.id])
            .unwrap();
        assert!(
            db.list_subagent_runs(&parent)
                .unwrap()
                .iter()
                .all(|row| row.linked_session_id.is_none())
        );
        assert!(
            db.create_team_agent_tab(&parent, "launch")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rollback_removes_only_workers_launched_in_discarded_turns() {
        use crate::db::test_support::{make_chat_msg, setup_db_with_workspace};
        use crate::model::ChatRole;
        let db = setup_db_with_workspace();
        let session = db.default_session_id_for_workspace("w1").unwrap().unwrap();
        for id in ["first", "second"] {
            let message = make_chat_msg(&db, id, "w1", ChatRole::User, "review");
            db.insert_chat_message(&message).unwrap();
            let update = SubagentRunUpdate {
                run_id: id.into(),
                harness: "codex".into(),
                status: Some("running".into()),
                ..Default::default()
            };
            db.observe_subagent(&session, &update).unwrap();
        }
        let update = SubagentRunUpdate {
            run_id: "first".into(),
            harness: "codex".into(),
            status: Some("completed".into()),
            ..Default::default()
        };
        db.observe_subagent(&session, &update).unwrap();
        db.conn
            .execute(
                "UPDATE subagent_runs SET observer_id='previous-process'",
                [],
            )
            .unwrap();
        let snapshot = db.list_subagent_runs(&session).unwrap();
        assert_eq!(snapshot[0].native.status.as_deref(), Some("completed"));
        assert_eq!(snapshot[1].native.status.as_deref(), Some("disconnected"));
        db.delete_session_messages_after(&session, "first").unwrap();
        let rows = db.list_subagent_runs(&session).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].native, update);
        db.delete_chat_messages_for_session(&session).unwrap();
        assert!(db.list_subagent_runs(&session).unwrap().is_empty());
    }

    #[test]
    fn merges_native_and_reported_state_without_reopening_or_crossing_sessions() {
        let db = crate::db::test_support::setup_db_with_workspace();
        let session = db.default_session_id_for_workspace("w1").unwrap().unwrap();
        let mut u = SubagentRunUpdate {
            harness: "codex".into(),
            run_id: "worker".into(),
            status: Some("running".into()),
            ..Default::default()
        };
        assert!(db.observe_subagent(&session, &u).unwrap().is_some());
        assert!(db.observe_subagent(&session, &u).unwrap().is_none());
        assert!(
            db.report_subagent_progress("other", "codex", "worker", "result", "ready")
                .is_err()
        );
        let report = db
            .report_subagent_progress(&session, "codex", "worker", "result", "ready")
            .unwrap()
            .unwrap();
        assert_eq!(report.native.status.as_deref(), Some("running"));
        assert!(
            db.report_subagent_progress(&session, "codex", "worker", "result", "ready")
                .unwrap()
                .is_none()
        );
        u.status = Some("completed".into());
        let done = db.observe_subagent(&session, &u).unwrap().unwrap();
        assert_eq!(done.report_summary.as_deref(), Some("ready"));
        u.status = Some("running".into());
        assert!(db.observe_subagent(&session, &u).unwrap().is_none());
        assert_eq!(db.list_subagent_runs(&session).unwrap(), vec![done]);
        u.status = None;
        u.summary = Some("Late final answer".into());
        let late = db.observe_subagent(&session, &u).unwrap().unwrap();
        assert_eq!(late.native.status.as_deref(), Some("completed"));
        assert_eq!(late.native.summary, u.summary);
    }
}
