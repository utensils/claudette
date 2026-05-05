//! Terminal tab CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use crate::model::{TerminalTab, TerminalTabKind};

use super::Database;

pub const CLAUDETTE_TERMINAL_TITLE: &str = "Claudette terminal";

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
             FROM terminal_tabs
             WHERE workspace_id = ?1
               AND (
                   kind != 'agent_task'
                   OR id = (
                       SELECT id FROM terminal_tabs AS agent_terminal
                       WHERE agent_terminal.workspace_id = ?1
                         AND agent_terminal.kind = 'agent_task'
                         AND agent_terminal.title IN ('Claudette terminal', 'Agent shell')
                       ORDER BY
                         CASE WHEN agent_terminal.title = 'Claudette terminal' THEN 0 ELSE 1 END,
                         agent_terminal.id
                       LIMIT 1
                   )
               )
             ORDER BY
               sort_order,
               id",
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

    pub fn get_agent_shell_terminal_tab(
        &self,
        chat_session_id: &str,
    ) -> Result<Option<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, kind, is_script_output, sort_order, created_at,
                    agent_chat_session_id, agent_tool_use_id, agent_task_id,
                    output_path, task_status, task_summary
             FROM terminal_tabs
             WHERE agent_chat_session_id = ?1
               AND kind = 'agent_task'
               AND title IN ('Claudette terminal', 'Agent shell')
             ORDER BY CASE WHEN title = 'Claudette terminal' THEN 0 ELSE 1 END, id
             LIMIT 1",
        )?;
        let mut rows = stmt.query(params![chat_session_id])?;
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

    pub fn get_agent_shell_terminal_tab_by_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, kind, is_script_output, sort_order, created_at,
                    agent_chat_session_id, agent_tool_use_id, agent_task_id,
                    output_path, task_status, task_summary
             FROM terminal_tabs
             WHERE workspace_id = ?1
               AND kind = 'agent_task'
               AND title IN ('Claudette terminal', 'Agent shell')
             ORDER BY CASE WHEN title = 'Claudette terminal' THEN 0 ELSE 1 END, id
             LIMIT 1",
        )?;
        let mut rows = stmt.query(params![workspace_id])?;
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

    pub fn update_agent_shell_terminal_tab_session(
        &self,
        id: i64,
        chat_session_id: &str,
        output_path: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs
             SET title = 'Claudette terminal',
                 agent_chat_session_id = ?1,
                 agent_tool_use_id = NULL,
                 agent_task_id = NULL,
                 output_path = ?2,
                 task_status = NULL,
                 task_summary = NULL
             WHERE id = ?3",
            params![chat_session_id, output_path, id],
        )?;
        Ok(())
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

    pub fn update_agent_shell_terminal_tab_status(
        &self,
        chat_session_id: &str,
        task_id: Option<&str>,
        status: &str,
        summary: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs
             SET agent_task_id = ?1,
                 task_status = ?2,
                 task_summary = COALESCE(?3, task_summary)
             WHERE agent_chat_session_id = ?4
               AND kind = 'agent_task'
               AND title IN ('Claudette terminal', 'Agent shell')",
            params![task_id, status, summary, chat_session_id],
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

    pub fn update_terminal_tab_sort_order(
        &self,
        workspace_id: &str,
        tab_ids: &[i64],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE terminal_tabs
                 SET sort_order = ?1
                 WHERE workspace_id = ?2 AND id = ?3",
            )?;
            for (sort_order, id) in tab_ids.iter().enumerate() {
                stmt.execute(params![sort_order as i32, workspace_id, id])?;
            }
        }
        tx.commit()?;
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

    fn make_agent_terminal_tab(
        id: i64,
        ws_id: &str,
        title: &str,
        chat_session_id: &str,
    ) -> TerminalTab {
        TerminalTab {
            kind: TerminalTabKind::AgentTask,
            agent_chat_session_id: Some(chat_session_id.into()),
            ..make_terminal_tab(id, ws_id, title)
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
    fn test_agent_terminal_tabs_are_single_visible_tab_ordered_by_sort_order() {
        let db = setup_db_with_workspace();
        let mut user_tab = make_terminal_tab(1, "w1", "Terminal 1");
        user_tab.sort_order = 0;
        db.insert_terminal_tab(&user_tab).unwrap();
        db.insert_terminal_tab(&make_agent_terminal_tab(
            2,
            "w1",
            "Agent: sleep 30 && date",
            "chat-1",
        ))
        .unwrap();
        let mut claudette_tab =
            make_agent_terminal_tab(3, "w1", CLAUDETTE_TERMINAL_TITLE, "chat-1");
        claudette_tab.sort_order = 1;
        db.insert_terminal_tab(&claudette_tab).unwrap();

        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].title, "Terminal 1");
        assert_eq!(tabs[1].title, CLAUDETTE_TERMINAL_TITLE);
    }

    #[test]
    fn test_agent_terminal_session_update_resets_legacy_task_metadata() {
        let db = setup_db_with_workspace();
        let mut legacy = make_agent_terminal_tab(2, "w1", "Agent shell", "old-chat");
        legacy.agent_tool_use_id = Some("toolu-old".into());
        legacy.agent_task_id = Some("task-old".into());
        legacy.output_path = Some("/tmp/old.output".into());
        legacy.task_status = Some("running".into());
        legacy.task_summary = Some("old command".into());
        db.insert_terminal_tab(&legacy).unwrap();

        db.update_agent_shell_terminal_tab_session(2, "new-chat", "/tmp/new.output")
            .unwrap();

        let tab = db
            .get_agent_shell_terminal_tab("new-chat")
            .unwrap()
            .unwrap();
        assert_eq!(tab.title, CLAUDETTE_TERMINAL_TITLE);
        assert_eq!(tab.sort_order, legacy.sort_order);
        assert_eq!(tab.agent_chat_session_id.as_deref(), Some("new-chat"));
        assert_eq!(tab.agent_tool_use_id, None);
        assert_eq!(tab.agent_task_id, None);
        assert_eq!(tab.output_path.as_deref(), Some("/tmp/new.output"));
        assert_eq!(tab.task_status, None);
        assert_eq!(tab.task_summary, None);
    }

    #[test]
    fn test_agent_terminal_status_updates_task_binding_and_keeps_summary() {
        let db = setup_db_with_workspace();
        let mut tab = make_agent_terminal_tab(2, "w1", CLAUDETTE_TERMINAL_TITLE, "chat-1");
        tab.task_summary = Some("sleep 30 && date".into());
        db.insert_terminal_tab(&tab).unwrap();

        db.update_agent_shell_terminal_tab_status("chat-1", Some("task-1"), "running", None)
            .unwrap();
        let running = db.get_agent_shell_terminal_tab("chat-1").unwrap().unwrap();
        assert_eq!(running.agent_task_id.as_deref(), Some("task-1"));
        assert_eq!(running.task_status.as_deref(), Some("running"));
        assert_eq!(running.task_summary.as_deref(), Some("sleep 30 && date"));

        db.update_agent_shell_terminal_tab_status(
            "chat-1",
            Some("task-1"),
            "completed",
            Some("exit 0"),
        )
        .unwrap();
        let completed = db.get_agent_shell_terminal_tab("chat-1").unwrap().unwrap();
        assert_eq!(completed.agent_task_id.as_deref(), Some("task-1"));
        assert_eq!(completed.task_status.as_deref(), Some("completed"));
        assert_eq!(completed.task_summary.as_deref(), Some("exit 0"));
    }

    #[test]
    fn test_agent_terminal_status_ignores_command_task_tabs() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_agent_terminal_tab(
            2,
            "w1",
            CLAUDETTE_TERMINAL_TITLE,
            "chat-1",
        ))
        .unwrap();
        let mut command_tab = make_agent_terminal_tab(3, "w1", "Agent: sleep 30 && date", "chat-1");
        command_tab.agent_tool_use_id = Some("toolu-command".into());
        command_tab.task_status = Some("running".into());
        db.insert_terminal_tab(&command_tab).unwrap();

        db.update_agent_shell_terminal_tab_status(
            "chat-1",
            Some("task-1"),
            "completed",
            Some("exit 0"),
        )
        .unwrap();

        let command_tab = db
            .get_terminal_tab_by_tool_use_id("toolu-command")
            .unwrap()
            .unwrap();
        assert_eq!(command_tab.agent_task_id, None);
        assert_eq!(command_tab.task_status.as_deref(), Some("running"));
        let shell = db.get_agent_shell_terminal_tab("chat-1").unwrap().unwrap();
        assert_eq!(shell.task_status.as_deref(), Some("completed"));
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
    fn test_update_terminal_tab_sort_order() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 2"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(3, "w1", "Terminal 3"))
            .unwrap();

        db.update_terminal_tab_sort_order("w1", &[3, 1, 2]).unwrap();

        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        let ids: Vec<_> = tabs.iter().map(|tab| tab.id).collect();
        assert_eq!(ids, vec![3, 1, 2]);
    }

    #[test]
    fn test_update_terminal_tab_sort_order_can_move_agent_terminal() {
        let db = setup_db_with_workspace();
        let mut agent_tab = make_agent_terminal_tab(1, "w1", CLAUDETTE_TERMINAL_TITLE, "chat-1");
        agent_tab.sort_order = -1;
        db.insert_terminal_tab(&agent_tab).unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 1"))
            .unwrap();

        db.update_terminal_tab_sort_order("w1", &[2, 1]).unwrap();

        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        let ids: Vec<_> = tabs.iter().map(|tab| tab.id).collect();
        assert_eq!(ids, vec![2, 1]);
    }

    #[test]
    fn test_update_terminal_tab_sort_order_is_workspace_scoped() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "workspace-2"))
            .unwrap();
        let mut w1_tab = make_terminal_tab(1, "w1", "Terminal 1");
        w1_tab.sort_order = 0;
        let mut w2_tab = make_terminal_tab(2, "w2", "Terminal 2");
        w2_tab.sort_order = 0;
        db.insert_terminal_tab(&w1_tab).unwrap();
        db.insert_terminal_tab(&w2_tab).unwrap();

        db.update_terminal_tab_sort_order("w1", &[2, 1]).unwrap();

        let w1_tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        let w2_tabs = db.list_terminal_tabs_by_workspace("w2").unwrap();
        assert_eq!(w1_tabs[0].id, 1);
        assert_eq!(w1_tabs[0].sort_order, 1);
        assert_eq!(w2_tabs[0].id, 2);
        assert_eq!(w2_tabs[0].sort_order, 0);
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
