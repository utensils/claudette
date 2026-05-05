//! Terminal tab CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use crate::model::{TerminalTab, TerminalTabKind};

use super::Database;

impl Database {
    // --- Terminal Tabs ---

    pub fn insert_terminal_tab(&self, tab: &TerminalTab) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO terminal_tabs (
                id, workspace_id, title, kind, is_script_output, sort_order,
                agent_chat_session_id, agent_tool_use_id, agent_task_id,
                output_path, task_status, task_summary
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                tab.id,
                tab.workspace_id,
                tab.title,
                terminal_tab_kind_to_str(tab.kind),
                tab.is_script_output as i32,
                tab.sort_order,
                tab.agent_chat_session_id,
                tab.agent_tool_use_id,
                tab.agent_task_id,
                tab.output_path,
                tab.task_status,
                tab.task_summary,
            ],
        )?;
        Ok(())
    }

    pub fn max_terminal_tab_id(&self) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COALESCE(MAX(id), 0) FROM terminal_tabs",
            [],
            |row| row.get(0),
        )
    }

    pub fn list_terminal_tabs_by_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, kind, is_script_output, sort_order, created_at,
                    agent_chat_session_id, agent_tool_use_id, agent_task_id,
                    output_path, task_status, task_summary
             FROM terminal_tabs WHERE workspace_id = ?1 ORDER BY sort_order, id",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            let kind: String = row.get(3)?;
            let is_script: i32 = row.get(4)?;
            Ok(TerminalTab {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                title: row.get(2)?,
                kind: parse_terminal_tab_kind(&kind),
                is_script_output: is_script != 0,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                agent_chat_session_id: row.get(7)?,
                agent_tool_use_id: row.get(8)?,
                agent_task_id: row.get(9)?,
                output_path: row.get(10)?,
                task_status: row.get(11)?,
                task_summary: row.get(12)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_terminal_tab_by_tool_use_id(
        &self,
        tool_use_id: &str,
    ) -> Result<Option<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, kind, is_script_output, sort_order, created_at,
                    agent_chat_session_id, agent_tool_use_id, agent_task_id,
                    output_path, task_status, task_summary
             FROM terminal_tabs WHERE agent_tool_use_id = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![tool_use_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let kind: String = row.get(3)?;
        let is_script: i32 = row.get(4)?;
        Ok(Some(TerminalTab {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            title: row.get(2)?,
            kind: parse_terminal_tab_kind(&kind),
            is_script_output: is_script != 0,
            sort_order: row.get(5)?,
            created_at: row.get(6)?,
            agent_chat_session_id: row.get(7)?,
            agent_tool_use_id: row.get(8)?,
            agent_task_id: row.get(9)?,
            output_path: row.get(10)?,
            task_status: row.get(11)?,
            task_summary: row.get(12)?,
        }))
    }

    pub fn get_terminal_tab_by_agent_task(
        &self,
        chat_session_id: &str,
        task_id: &str,
    ) -> Result<Option<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, kind, is_script_output, sort_order, created_at,
                    agent_chat_session_id, agent_tool_use_id, agent_task_id,
                    output_path, task_status, task_summary
             FROM terminal_tabs
             WHERE agent_chat_session_id = ?1 AND agent_task_id = ?2
             LIMIT 1",
        )?;
        let mut rows = stmt.query(params![chat_session_id, task_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let kind: String = row.get(3)?;
        let is_script: i32 = row.get(4)?;
        Ok(Some(TerminalTab {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            title: row.get(2)?,
            kind: parse_terminal_tab_kind(&kind),
            is_script_output: is_script != 0,
            sort_order: row.get(5)?,
            created_at: row.get(6)?,
            agent_chat_session_id: row.get(7)?,
            agent_tool_use_id: row.get(8)?,
            agent_task_id: row.get(9)?,
            output_path: row.get(10)?,
            task_status: row.get(11)?,
            task_summary: row.get(12)?,
        }))
    }

    pub fn update_agent_task_terminal_tab_binding(
        &self,
        tool_use_id: &str,
        task_id: &str,
        output_path: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs
             SET agent_task_id = ?1, output_path = ?2, task_status = 'running'
             WHERE agent_tool_use_id = ?3",
            params![task_id, output_path, tool_use_id],
        )?;
        Ok(())
    }

    pub fn update_agent_task_terminal_tab_by_tool_use_id(
        &self,
        tool_use_id: &str,
        status: &str,
        summary: Option<&str>,
        output_path: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs
             SET task_status = ?1,
                 task_summary = COALESCE(?2, task_summary),
                 output_path = COALESCE(?3, output_path)
             WHERE agent_tool_use_id = ?4",
            params![status, summary, output_path, tool_use_id],
        )?;
        Ok(())
    }

    pub fn update_agent_task_terminal_tab_status(
        &self,
        chat_session_id: &str,
        task_id: &str,
        status: &str,
        summary: Option<&str>,
        output_path: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs
             SET task_status = ?1,
                 task_summary = COALESCE(?2, task_summary),
                 output_path = COALESCE(?3, output_path)
             WHERE agent_chat_session_id = ?4 AND agent_task_id = ?5",
            params![status, summary, output_path, chat_session_id, task_id],
        )?;
        Ok(())
    }

    pub fn delete_terminal_tab(&self, id: i64) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM terminal_tabs WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn delete_terminal_tabs_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM terminal_tabs WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_terminal_tab_title(&self, id: i64, title: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        Ok(())
    }
}

fn terminal_tab_kind_to_str(kind: TerminalTabKind) -> &'static str {
    match kind {
        TerminalTabKind::Pty => "pty",
        TerminalTabKind::AgentTask => "agent_task",
    }
}

fn parse_terminal_tab_kind(raw: &str) -> TerminalTabKind {
    match raw {
        "agent_task" => TerminalTabKind::AgentTask,
        _ => TerminalTabKind::Pty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

    fn make_terminal_tab(id: i64, ws_id: &str, title: &str) -> TerminalTab {
        TerminalTab {
            id,
            workspace_id: ws_id.into(),
            title: title.into(),
            kind: TerminalTabKind::Pty,
            is_script_output: false,
            sort_order: 0,
            created_at: String::new(),
            agent_chat_session_id: None,
            agent_tool_use_id: None,
            agent_task_id: None,
            output_path: None,
            task_status: None,
            task_summary: None,
        }
    }

    #[test]
    fn test_insert_and_list_terminal_tabs() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 2"))
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].title, "Terminal 1");
        assert_eq!(tabs[1].title, "Terminal 2");
    }

    #[test]
    fn test_terminal_tabs_filtered_by_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "T1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w2", "T2"))
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].title, "T1");
    }

    #[test]
    fn test_delete_terminal_tab() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.delete_terminal_tab(1).unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs.is_empty());
    }

    #[test]
    fn test_terminal_tabs_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 2"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs.is_empty());
    }

    #[test]
    fn test_terminal_tab_script_output_flag() {
        let db = setup_db_with_workspace();
        let mut tab = make_terminal_tab(1, "w1", "npm run dev");
        tab.is_script_output = true;
        db.insert_terminal_tab(&tab).unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs[0].is_script_output);
    }

    #[test]
    fn test_update_terminal_tab_title() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.update_terminal_tab_title(1, "My Custom Terminal")
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs[0].title, "My Custom Terminal");
    }
}
