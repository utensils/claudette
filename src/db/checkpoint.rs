//! Conversation checkpoint and rollback CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use crate::model::{
    ChatMessage, CheckpointFile, CompletedTurnData, ConversationCheckpoint, TurnToolActivity,
};

use super::Database;

impl Database {
    // --- Conversation Checkpoints ---

    pub fn insert_checkpoint(&self, cp: &ConversationCheckpoint) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO conversation_checkpoints
                (id, workspace_id, chat_session_id, message_id, commit_hash, turn_index, message_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                cp.id,
                cp.workspace_id,
                cp.chat_session_id,
                cp.message_id,
                cp.commit_hash,
                cp.turn_index,
                cp.message_count
            ],
        )?;
        Ok(())
    }

    fn parse_checkpoint_row(row: &rusqlite::Row) -> rusqlite::Result<ConversationCheckpoint> {
        Ok(ConversationCheckpoint {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            chat_session_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            message_id: row.get(3)?,
            commit_hash: row.get(4)?,
            has_file_state: row.get(5)?,
            turn_index: row.get(6)?,
            message_count: row.get(7)?,
            created_at: row.get(8)?,
        })
    }

    /// SQL column list for checkpoint queries, including a subquery for has_file_state.
    const CHECKPOINT_COLS: &str = "id, workspace_id, chat_session_id, message_id, commit_hash, \
         EXISTS(SELECT 1 FROM checkpoint_files WHERE checkpoint_id = conversation_checkpoints.id) AS has_file_state, \
         turn_index, message_count, created_at";

    pub fn list_checkpoints(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE workspace_id = ?1 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_checkpoint_row)?;
        rows.collect()
    }

    pub fn list_checkpoints_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE chat_session_id = ?1 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![chat_session_id], Self::parse_checkpoint_row)?;
        rows.collect()
    }

    /// Delete checkpoints for a session after a given turn index. Used for
    /// rollback — everything after the chosen turn is pruned.
    pub fn delete_session_checkpoints_after(
        &self,
        chat_session_id: &str,
        turn_index: i32,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE chat_session_id = ?1 AND turn_index > ?2",
            params![chat_session_id, turn_index],
        )?;
        Ok(deleted)
    }

    pub fn delete_checkpoint(&self, checkpoint_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE id = ?1",
            params![checkpoint_id],
        )?;
        Ok(())
    }

    pub fn get_checkpoint(
        &self,
        id: &str,
    ) -> Result<Option<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE id = ?1",
            Self::CHECKPOINT_COLS
        );
        self.conn
            .query_row(&sql, params![id], Self::parse_checkpoint_row)
            .optional()
    }

    pub fn latest_checkpoint(
        &self,
        workspace_id: &str,
    ) -> Result<Option<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints \
             WHERE workspace_id = ?1 ORDER BY turn_index DESC LIMIT 1",
            Self::CHECKPOINT_COLS
        );
        self.conn
            .query_row(&sql, params![workspace_id], Self::parse_checkpoint_row)
            .optional()
    }

    pub fn delete_checkpoints_after(
        &self,
        workspace_id: &str,
        turn_index: i32,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE workspace_id = ?1 AND turn_index > ?2",
            params![workspace_id, turn_index],
        )?;
        Ok(deleted)
    }

    /// Return checkpoints for `workspace_id` whose `turn_index` is at most
    /// `max_turn_index`, ordered by `turn_index`. Used by the fork
    /// orchestrator to copy only checkpoints up to (and including) the fork
    /// point.
    pub fn list_checkpoints_up_to(
        &self,
        workspace_id: &str,
        max_turn_index: i32,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints \
             WHERE workspace_id = ?1 AND turn_index <= ?2 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_id, max_turn_index],
            Self::parse_checkpoint_row,
        )?;
        rows.collect()
    }

    /// Return chat messages for `workspace_id` up to and including the row
    /// identified by `last_message_id`, ordered by (created_at, rowid). If
    /// `last_message_id` is not found, returns an empty vec. Used by the fork
    /// orchestrator to copy conversation history up to the fork point.
    pub fn list_messages_up_to(
        &self,
        workspace_id: &str,
        last_message_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let boundary: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT created_at, rowid FROM chat_messages \
                 WHERE id = ?1 AND workspace_id = ?2",
                params![last_message_id, workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((created_at, rowid)) = boundary else {
            return Ok(Vec::new());
        };

        let sql = format!(
            "SELECT {} FROM chat_messages
             WHERE workspace_id = ?1
               AND (created_at < ?2 OR (created_at = ?2 AND rowid <= ?3))
             ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_id, created_at, rowid],
            Self::parse_chat_message_row,
        )?;
        rows.collect()
    }

    // --- Checkpoint Files ---

    pub fn insert_checkpoint_files(&self, files: &[CheckpointFile]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO checkpoint_files (id, checkpoint_id, file_path, content, file_mode)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for f in files {
                stmt.execute(params![
                    f.id,
                    f.checkpoint_id,
                    f.file_path,
                    f.content,
                    f.file_mode,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_checkpoint_files(
        &self,
        checkpoint_id: &str,
    ) -> Result<Vec<CheckpointFile>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, checkpoint_id, file_path, content, file_mode
             FROM checkpoint_files WHERE checkpoint_id = ?1",
        )?;
        let rows = stmt.query_map(params![checkpoint_id], |row| {
            Ok(CheckpointFile {
                id: row.get(0)?,
                checkpoint_id: row.get(1)?,
                file_path: row.get(2)?,
                content: row.get(3)?,
                file_mode: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn has_checkpoint_files(&self, checkpoint_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM checkpoint_files WHERE checkpoint_id = ?1)",
            params![checkpoint_id],
            |row| row.get(0),
        )
    }

    // --- Turn Tool Activities ---

    pub fn insert_turn_tool_activities(
        &self,
        activities: &[TurnToolActivity],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO turn_tool_activities (
                    id, checkpoint_id, tool_use_id, tool_name, input_json,
                    result_text, summary, sort_order, assistant_message_ordinal,
                    agent_task_id, agent_description, agent_last_tool_name,
                    agent_tool_use_count, agent_status, agent_tool_calls_json,
                    agent_thinking_blocks_json, agent_result_text
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            )?;
            for a in activities {
                stmt.execute(params![
                    a.id,
                    a.checkpoint_id,
                    a.tool_use_id,
                    a.tool_name,
                    a.input_json,
                    a.result_text,
                    a.summary,
                    a.sort_order,
                    a.assistant_message_ordinal,
                    a.agent_task_id,
                    a.agent_description,
                    a.agent_last_tool_name,
                    a.agent_tool_use_count,
                    a.agent_status,
                    a.agent_tool_calls_json,
                    a.agent_thinking_blocks_json,
                    a.agent_result_text,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_checkpoint_message_count(
        &self,
        checkpoint_id: &str,
        message_count: i32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE conversation_checkpoints SET message_count = ?1 WHERE id = ?2",
            params![message_count, checkpoint_id],
        )?;
        Ok(())
    }

    /// Atomically update the checkpoint message count and insert tool activities.
    pub fn save_turn_tool_activities(
        &self,
        checkpoint_id: &str,
        message_count: i32,
        activities: &[TurnToolActivity],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE conversation_checkpoints SET message_count = ?1 WHERE id = ?2",
            params![message_count, checkpoint_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO turn_tool_activities (
                    id, checkpoint_id, tool_use_id, tool_name, input_json,
                    result_text, summary, sort_order, assistant_message_ordinal,
                    agent_task_id, agent_description, agent_last_tool_name,
                    agent_tool_use_count, agent_status, agent_tool_calls_json,
                    agent_thinking_blocks_json, agent_result_text
                 )
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            )?;
            for a in activities {
                stmt.execute(params![
                    a.id,
                    a.checkpoint_id,
                    a.tool_use_id,
                    a.tool_name,
                    a.input_json,
                    a.result_text,
                    a.summary,
                    a.sort_order,
                    a.assistant_message_ordinal,
                    a.agent_task_id,
                    a.agent_description,
                    a.agent_last_tool_name,
                    a.agent_tool_use_count,
                    a.agent_status,
                    a.agent_tool_calls_json,
                    a.agent_thinking_blocks_json,
                    a.agent_result_text,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Load all completed turns for a workspace: checkpoints joined with their
    /// tool activities, grouped by checkpoint and ordered by turn_index.
    pub fn list_completed_turns(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CompletedTurnData>, rusqlite::Error> {
        // First get the checkpoints.
        let checkpoints = self.list_checkpoints(workspace_id)?;

        // Then load all activities for this workspace in one query.
        let mut stmt = self.conn.prepare(
            "SELECT ta.id, ta.checkpoint_id, ta.tool_use_id, ta.tool_name,
                    ta.input_json, ta.result_text, ta.summary, ta.sort_order,
                    ta.assistant_message_ordinal, ta.agent_task_id,
                    ta.agent_description, ta.agent_last_tool_name,
                    ta.agent_tool_use_count, ta.agent_status, ta.agent_tool_calls_json,
                    ta.agent_thinking_blocks_json, ta.agent_result_text
             FROM turn_tool_activities ta
             JOIN conversation_checkpoints cp ON ta.checkpoint_id = cp.id
             WHERE cp.workspace_id = ?1
             ORDER BY cp.turn_index, ta.assistant_message_ordinal, ta.sort_order",
        )?;
        let activities: Vec<TurnToolActivity> = stmt
            .query_map(params![workspace_id], |row| {
                Ok(TurnToolActivity {
                    id: row.get(0)?,
                    checkpoint_id: row.get(1)?,
                    tool_use_id: row.get(2)?,
                    tool_name: row.get(3)?,
                    input_json: row.get(4)?,
                    result_text: row.get(5)?,
                    summary: row.get(6)?,
                    sort_order: row.get(7)?,
                    assistant_message_ordinal: row.get(8)?,
                    agent_task_id: row.get(9)?,
                    agent_description: row.get(10)?,
                    agent_last_tool_name: row.get(11)?,
                    agent_tool_use_count: row.get(12)?,
                    agent_status: row.get(13)?,
                    agent_tool_calls_json: row.get(14)?,
                    agent_thinking_blocks_json: row.get(15)?,
                    agent_result_text: row.get(16)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Group activities by checkpoint_id.
        let mut activity_map: std::collections::HashMap<String, Vec<TurnToolActivity>> =
            std::collections::HashMap::new();
        for a in activities {
            activity_map
                .entry(a.checkpoint_id.clone())
                .or_default()
                .push(a);
        }

        Ok(checkpoints
            .into_iter()
            .filter_map(|cp| {
                let acts = activity_map.remove(&cp.id).unwrap_or_default();
                // Only return turns that actually had tool activities.
                // Checkpoints for assistant-only turns don't need summaries.
                if acts.is_empty() {
                    return None;
                }
                Some(CompletedTurnData {
                    checkpoint_id: cp.id,
                    message_id: cp.message_id,
                    turn_index: cp.turn_index,
                    message_count: cp.message_count,
                    commit_hash: cp.commit_hash,
                    activities: acts,
                })
            })
            .collect())
    }

    /// Delete all chat messages inserted after the given message (by rowid order).
    /// Returns the number of messages deleted.
    pub fn delete_messages_after(
        &self,
        workspace_id: &str,
        after_message_id: &str,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM chat_messages
             WHERE workspace_id = ?1
               AND rowid > (SELECT rowid FROM chat_messages WHERE id = ?2)",
            params![workspace_id, after_message_id],
        )?;
        Ok(deleted)
    }

    /// Delete all messages inserted after `after_message_id` *within the
    /// given chat session*. The rowid-ordering match is scoped to that
    /// chat session so a rollback in tab A cannot prune messages in tab B.
    pub fn delete_session_messages_after(
        &self,
        chat_session_id: &str,
        after_message_id: &str,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM chat_messages
             WHERE chat_session_id = ?1
               AND rowid > (SELECT rowid FROM chat_messages WHERE id = ?2)",
            params![chat_session_id, after_message_id],
        )?;
        Ok(deleted)
    }

    /// Session-scoped variant of [`Self::list_completed_turns`].
    pub fn list_completed_turns_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<CompletedTurnData>, rusqlite::Error> {
        let checkpoints = self.list_checkpoints_for_session(chat_session_id)?;

        let mut stmt = self.conn.prepare(
            "SELECT ta.id, ta.checkpoint_id, ta.tool_use_id, ta.tool_name,
                    ta.input_json, ta.result_text, ta.summary, ta.sort_order,
                    ta.assistant_message_ordinal, ta.agent_task_id,
                    ta.agent_description, ta.agent_last_tool_name,
                    ta.agent_tool_use_count, ta.agent_status, ta.agent_tool_calls_json,
                    ta.agent_thinking_blocks_json, ta.agent_result_text
             FROM turn_tool_activities ta
             JOIN conversation_checkpoints cp ON ta.checkpoint_id = cp.id
             WHERE cp.chat_session_id = ?1
             ORDER BY cp.turn_index, ta.assistant_message_ordinal, ta.sort_order",
        )?;
        let activities: Vec<TurnToolActivity> = stmt
            .query_map(params![chat_session_id], |row| {
                Ok(TurnToolActivity {
                    id: row.get(0)?,
                    checkpoint_id: row.get(1)?,
                    tool_use_id: row.get(2)?,
                    tool_name: row.get(3)?,
                    input_json: row.get(4)?,
                    result_text: row.get(5)?,
                    summary: row.get(6)?,
                    sort_order: row.get(7)?,
                    assistant_message_ordinal: row.get(8)?,
                    agent_task_id: row.get(9)?,
                    agent_description: row.get(10)?,
                    agent_last_tool_name: row.get(11)?,
                    agent_tool_use_count: row.get(12)?,
                    agent_status: row.get(13)?,
                    agent_tool_calls_json: row.get(14)?,
                    agent_thinking_blocks_json: row.get(15)?,
                    agent_result_text: row.get(16)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut activity_map: std::collections::HashMap<String, Vec<TurnToolActivity>> =
            std::collections::HashMap::new();
        for a in activities {
            activity_map
                .entry(a.checkpoint_id.clone())
                .or_default()
                .push(a);
        }

        Ok(checkpoints
            .into_iter()
            .filter_map(|cp| {
                let acts = activity_map.remove(&cp.id).unwrap_or_default();
                if acts.is_empty() {
                    return None;
                }
                Some(CompletedTurnData {
                    checkpoint_id: cp.id,
                    message_id: cp.message_id,
                    turn_index: cp.turn_index,
                    message_count: cp.message_count,
                    commit_hash: cp.commit_hash,
                    activities: acts,
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::model::ChatRole;

    /// Build a `ConversationCheckpoint` anchored to the workspace's default
    /// active session.
    fn make_checkpoint(
        db: &Database,
        id: &str,
        ws_id: &str,
        msg_id: &str,
        turn: i32,
    ) -> ConversationCheckpoint {
        let chat_session_id = db
            .default_session_id_for_workspace(ws_id)
            .unwrap()
            .expect("workspace must have a default session for tests");
        ConversationCheckpoint {
            id: id.into(),
            workspace_id: ws_id.into(),
            chat_session_id,
            message_id: msg_id.into(),
            commit_hash: Some(format!("abc{turn}")),
            has_file_state: false,
            turn_index: turn,
            message_count: 1,
            created_at: String::new(),
        }
    }

    fn make_tool_activity(id: &str, cp_id: &str, tool: &str, order: i32) -> TurnToolActivity {
        TurnToolActivity {
            id: id.into(),
            checkpoint_id: cp_id.into(),
            tool_use_id: format!("tu_{id}"),
            tool_name: tool.into(),
            input_json: r#"{"file":"test.rs"}"#.to_string(),
            result_text: "ok".into(),
            summary: format!("{tool} test.rs"),
            sort_order: order,
            assistant_message_ordinal: 0,
            agent_task_id: None,
            agent_description: None,
            agent_last_tool_name: None,
            agent_tool_use_count: None,
            agent_status: None,
            agent_tool_calls_json: "[]".into(),
            agent_thinking_blocks_json: "[]".into(),
            agent_result_text: None,
        }
    }

    #[test]
    fn test_checkpoint_crud() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m2", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m4", 1))
            .unwrap();

        // list
        let cps = db.list_checkpoints("w1").unwrap();
        assert_eq!(cps.len(), 2);
        assert_eq!(cps[0].turn_index, 0);
        assert_eq!(cps[1].turn_index, 1);

        // get
        let cp = db.get_checkpoint("cp1").unwrap().unwrap();
        assert_eq!(cp.message_id, "m2");

        // latest
        let latest = db.latest_checkpoint("w1").unwrap().unwrap();
        assert_eq!(latest.id, "cp2");
        assert_eq!(latest.turn_index, 1);
    }

    #[test]
    fn test_delete_messages_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m5", "w1", ChatRole::User, "q3"))
            .unwrap();

        let deleted = db.delete_messages_after("w1", "m2").unwrap();
        assert_eq!(deleted, 3);

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");
    }

    #[test]
    fn test_delete_messages_after_last_message_deletes_nothing() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();

        let deleted = db.delete_messages_after("w1", "m2").unwrap();
        assert_eq!(deleted, 0);

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn test_delete_checkpoints_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::Assistant, "a3"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp3", "w1", "m3", 2))
            .unwrap();

        let deleted = db.delete_checkpoints_after("w1", 0).unwrap();
        assert_eq!(deleted, 2);

        let cps = db.list_checkpoints("w1").unwrap();
        assert_eq!(cps.len(), 1);
        assert_eq!(cps[0].id, "cp1");
    }

    #[test]
    fn test_checkpoint_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        db.delete_workspace("w1").unwrap();

        let cps = db.list_checkpoints("w1").unwrap();
        assert!(cps.is_empty());
    }

    #[test]
    fn test_latest_checkpoint_returns_none_when_empty() {
        let db = setup_db_with_workspace();
        let result = db.latest_checkpoint("w1").unwrap();
        assert!(result.is_none());
    }

    // --- Turn tool activity tests ---

    #[test]
    fn test_insert_and_list_tool_activities() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        let activities = vec![
            make_tool_activity("a1", "cp1", "Read", 0),
            make_tool_activity("a2", "cp1", "Edit", 1),
        ];
        db.insert_turn_tool_activities(&activities).unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].activities.len(), 2);
        assert_eq!(turns[0].activities[0].tool_name, "Read");
        assert_eq!(turns[0].activities[1].tool_name, "Edit");
    }

    #[test]
    fn test_tool_activities_cascade_on_checkpoint_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_turn_tool_activities(&[make_tool_activity("a1", "cp1", "Read", 0)])
            .unwrap();

        db.delete_checkpoints_after("w1", -1).unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert!(turns.is_empty());
    }

    #[test]
    fn test_delete_checkpoint_deletes_exact_row_and_cascades_activities() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_turn_tool_activities(&[
            make_tool_activity("a1", "cp1", "Read", 0),
            make_tool_activity("a2", "cp2", "Edit", 0),
        ])
        .unwrap();

        db.delete_checkpoint("cp1").unwrap();

        assert!(db.get_checkpoint("cp1").unwrap().is_none());
        assert!(db.get_checkpoint("cp2").unwrap().is_some());
        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].checkpoint_id, "cp2");
        assert_eq!(turns[0].activities.len(), 1);
        assert_eq!(turns[0].activities[0].id, "a2");
    }

    #[test]
    fn test_list_completed_turns_groups_by_checkpoint() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();

        db.insert_turn_tool_activities(&[
            make_tool_activity("a1", "cp1", "Read", 0),
            make_tool_activity("a2", "cp1", "Edit", 1),
        ])
        .unwrap();
        db.insert_turn_tool_activities(&[make_tool_activity("a3", "cp2", "Bash", 0)])
            .unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].activities.len(), 2);
        assert_eq!(turns[1].activities.len(), 1);
        assert_eq!(turns[1].activities[0].tool_name, "Bash");
    }

    #[test]
    fn test_list_messages_up_to_includes_boundary() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "c"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "d"))
            .unwrap();

        let msgs = db.list_messages_up_to("w1", "m2").unwrap();
        let ids: Vec<_> = msgs.iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn test_list_messages_up_to_missing_returns_empty() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "a"))
            .unwrap();
        let msgs = db.list_messages_up_to("w1", "nonexistent").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_list_checkpoints_up_to() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::Assistant, "c"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp3", "w1", "m3", 2))
            .unwrap();

        let up_to_1 = db.list_checkpoints_up_to("w1", 1).unwrap();
        assert_eq!(up_to_1.len(), 2);
        assert_eq!(up_to_1[0].id, "cp1");
        assert_eq!(up_to_1[1].id, "cp2");
    }

    #[test]
    fn test_update_checkpoint_message_count() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        db.update_checkpoint_message_count("cp1", 3).unwrap();

        let cp = db.get_checkpoint("cp1").unwrap().unwrap();
        assert_eq!(cp.message_count, 3);
    }
}
