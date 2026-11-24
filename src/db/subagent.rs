use crate::model::{SubagentRun, SubagentRunUpdate};
use rusqlite::{OptionalExtension, Row, Transaction, TransactionBehavior, params};

use super::Database;

const COLUMNS: &str = "session_id,harness,run_id,parent_run_id,assignment,status,summary,tool_use_id,report_kind,report_summary,updated_at,revision";

fn read(row: &Row<'_>) -> rusqlite::Result<SubagentRun> {
    Ok(SubagentRun {
        session_id: row.get(0)?,
        native: SubagentRunUpdate {
            harness: row.get(1)?, run_id: row.get(2)?, parent_run_id: row.get(3)?,
            assignment: row.get(4)?, status: row.get(5)?, summary: row.get(6)?, tool_use_id: row.get(7)?,
        },
        report_kind: row.get(8)?, report_summary: row.get(9)?, updated_at: row.get(10)?, revision: row.get(11)?,
    })
}

fn terminal(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "stopped"))
}

impl Database {
    pub fn list_subagent_runs(&self, session: &str) -> rusqlite::Result<Vec<SubagentRun>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {COLUMNS} FROM subagent_runs WHERE session_id=?1 ORDER BY rowid"))?;
        stmt.query_map([session], read)?.collect()
    }

    /// Return only changed snapshots. Take the write lock before reading so a
    /// simultaneous MCP report and native event cannot overwrite each other.
    pub fn observe_subagent(&self, session: &str, update: &SubagentRunUpdate) -> rusqlite::Result<Option<SubagentRun>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let current = tx.query_row(&format!("SELECT {COLUMNS} FROM subagent_runs WHERE session_id=?1 AND harness=?2 AND run_id=?3"),
            params![session, update.harness, update.run_id], read).optional()?;
        let mut next = current.as_ref().map(|r| r.native.clone()).unwrap_or_default();
        next.harness.clone_from(&update.harness);
        next.run_id.clone_from(&update.run_id);
        if let Some(value) = &update.parent_run_id {next.parent_run_id = Some(value.clone());}
        if let Some(value) = &update.tool_use_id {next.tool_use_id = Some(value.clone());}
        if let Some(value) = &update.assignment {next.assignment = Some(value.clone());}
        // A replayed start must never reopen a finished worker. Only an explicit
        // native resume operation may start work again under the same identity.
        let resumed = update.status.as_deref() == Some("resumed");
        if resumed || !terminal(next.status.as_deref()) || terminal(update.status.as_deref()) {
            if let Some(status) = &update.status {next.status = Some(if resumed {"running".into()} else {status.clone()});}
            if let Some(value) = &update.summary {next.summary = Some(value.clone());}
        }
        if current.as_ref().is_some_and(|row| row.native == next) { return Ok(None); }
        let sql = format!("INSERT INTO subagent_runs(session_id,harness,run_id,parent_run_id,assignment,status,summary,tool_use_id,updated_at,revision)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1) ON CONFLICT(session_id,harness,run_id) DO UPDATE SET
            parent_run_id=excluded.parent_run_id,assignment=excluded.assignment,status=excluded.status,summary=excluded.summary,
            tool_use_id=excluded.tool_use_id,updated_at=excluded.updated_at,revision=revision+1 RETURNING {COLUMNS}");
        let row = tx.query_row(&sql, params![session,next.harness,next.run_id,next.parent_run_id,next.assignment,next.status,next.summary,next.tool_use_id,now()], read)?;
        tx.commit()?;
        Ok(Some(row))
    }

    pub fn report_subagent_progress(&self, session: &str, harness: &str, run: &str, kind: &str, summary: &str) -> Result<Option<SubagentRun>,String> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let key = params![session,harness,run];
        let current = tx.query_row(&format!("SELECT {COLUMNS} FROM subagent_runs WHERE session_id=?1 AND harness=?2 AND run_id=?3"),key,read)
            .optional().map_err(|e|e.to_string())?.ok_or("Unknown run in this chat and harness")?;
        if current.report_kind.as_deref()==Some(kind) && current.report_summary.as_deref()==Some(summary) { return Ok(None); }
        let sql = format!("UPDATE subagent_runs SET report_kind=?4,report_summary=?5,updated_at=?6,revision=revision+1
            WHERE session_id=?1 AND harness=?2 AND run_id=?3 RETURNING {COLUMNS}");
        let row = tx.query_row(&sql,params![session,harness,run,kind,summary,now()],read).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())?;
        Ok(Some(row))
    }
}

fn now() -> String {chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros,true)}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merges_native_and_reported_state_without_reopening_or_crossing_sessions() {
        let db = crate::db::test_support::setup_db_with_workspace();
        let session = db.default_session_id_for_workspace("w1").unwrap().unwrap();
        let mut u = SubagentRunUpdate {harness:"codex".into(),run_id:"worker".into(),status:Some("running".into()),..Default::default()};
        assert!(db.observe_subagent(&session,&u).unwrap().is_some());
        assert!(db.observe_subagent(&session,&u).unwrap().is_none());
        assert!(db.report_subagent_progress("other","codex","worker","result","ready").is_err());
        let report = db.report_subagent_progress(&session,"codex","worker","result","ready").unwrap().unwrap();
        assert_eq!(report.native.status.as_deref(),Some("running"));
        assert!(db.report_subagent_progress(&session,"codex","worker","result","ready").unwrap().is_none());
        u.status=Some("completed".into());
        let done=db.observe_subagent(&session,&u).unwrap().unwrap();
        assert_eq!(done.report_summary.as_deref(),Some("ready"));
        u.status=Some("running".into());
        assert!(db.observe_subagent(&session,&u).unwrap().is_none());
        assert_eq!(db.list_subagent_runs(&session).unwrap(),vec![done]);
    }
}
