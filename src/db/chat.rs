//! Chat session, message, and attachment CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use crate::model::{AgentStatus, Attachment, AttachmentOrigin, ChatMessage, ChatSession};

use super::Database;

fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    let data: Vec<u8> = row.get(4)?;
    let origin_str: String = row.get(9)?;
    Ok(Attachment {
        id: row.get(0)?,
        message_id: row.get(1)?,
        filename: row.get(2)?,
        media_type: row.get(3)?,
        size_bytes: row.get(7)?,
        data,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: row.get(8)?,
        origin: AttachmentOrigin::from_sql_str(&origin_str),
        tool_use_id: row.get(10)?,
    })
}

const ATTACHMENT_COLUMNS: &str = "id, message_id, filename, media_type, data, width, height, size_bytes, created_at, origin, tool_use_id";

impl Database {
    // --- Chat Messages ---

    #[allow(dead_code)]
    pub fn insert_chat_message(&self, msg: &ChatMessage) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO chat_messages (
                id, workspace_id, chat_session_id, role, content, cost_usd, duration_ms, thinking,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                msg.id,
                msg.workspace_id,
                msg.chat_session_id,
                msg.role.as_str(),
                msg.content,
                msg.cost_usd,
                msg.duration_ms,
                msg.thinking,
                msg.input_tokens,
                msg.output_tokens,
                msg.cache_read_tokens,
                msg.cache_creation_tokens,
            ],
        )?;
        Ok(())
    }

    pub(super) fn parse_chat_message_row(row: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
        let role_str: String = row.get(3)?;
        let chat_session_id: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        let role = role_str.parse().map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(ChatMessage {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            chat_session_id,
            role,
            content: row.get(4)?,
            cost_usd: row.get(5)?,
            duration_ms: row.get(6)?,
            created_at: row.get(7)?,
            thinking: row.get(8)?,
            input_tokens: row.get(9)?,
            output_tokens: row.get(10)?,
            cache_read_tokens: row.get(11)?,
            cache_creation_tokens: row.get(12)?,
        })
    }

    pub(super) const CHAT_MESSAGE_COLS: &str = "id, workspace_id, chat_session_id, role, content, cost_usd, \
         duration_ms, created_at, thinking, input_tokens, output_tokens, cache_read_tokens, \
         cache_creation_tokens";

    #[allow(dead_code)]
    pub fn list_chat_messages(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_messages WHERE workspace_id = ?1 ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_chat_message_row)?;
        rows.collect()
    }

    /// List all chat messages for a single chat session, ordered chronologically.
    pub fn list_chat_messages_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_messages WHERE chat_session_id = ?1 ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![chat_session_id], Self::parse_chat_message_row)?;
        rows.collect()
    }

    #[allow(dead_code)]
    pub fn update_chat_message_content(
        &self,
        id: &str,
        content: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
            params![content, id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_chat_message_cost(
        &self,
        id: &str,
        cost_usd: f64,
        duration_ms: i64,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_messages SET cost_usd = ?1, duration_ms = ?2 WHERE id = ?3",
            params![cost_usd, duration_ms, id],
        )?;
        Ok(())
    }

    /// Get the most recent chat message for each workspace (for dashboard display).
    /// Uses a correlated subquery with rowid tie-breaking to guarantee exactly
    /// one row per workspace even when multiple messages share the same timestamp.
    pub fn last_message_per_workspace(&self) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        // Prefix each column with `m.` so the correlated subquery references are unambiguous.
        let prefixed: String = Self::CHAT_MESSAGE_COLS
            .split(", ")
            .map(|c| format!("m.{}", c.trim()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {prefixed} FROM chat_messages m
             WHERE m.rowid = (
                 SELECT rowid FROM chat_messages c2
                 WHERE c2.workspace_id = m.workspace_id
                 ORDER BY c2.created_at DESC, c2.rowid DESC
                 LIMIT 1
             )"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::parse_chat_message_row)?;
        rows.collect()
    }

    #[allow(dead_code)]
    pub fn delete_chat_messages_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM chat_messages WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    /// Delete all messages for a single chat session. Cascades to attachments.
    pub fn delete_chat_messages_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM chat_messages WHERE chat_session_id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    // --- Chat Sessions ---

    const CHAT_SESSION_COLS: &str = "id, workspace_id, session_id, name, name_edited, \
         turn_count, sort_order, status, created_at, archived_at";

    fn parse_chat_session_row(row: &rusqlite::Row) -> rusqlite::Result<ChatSession> {
        let status_str: String = row.get(7)?;
        let status = status_str.parse().map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(ChatSession {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            session_id: row.get(2)?,
            name: row.get(3)?,
            name_edited: row.get::<_, i32>(4)? != 0,
            turn_count: row.get(5)?,
            sort_order: row.get(6)?,
            status,
            created_at: row.get(8)?,
            archived_at: row.get(9)?,
            agent_status: AgentStatus::Idle,
            needs_attention: false,
            attention_kind: None,
        })
    }

    /// Insert a new active session. Returns the inserted row.
    pub fn create_chat_session(&self, workspace_id: &str) -> Result<ChatSession, rusqlite::Error> {
        // New sessions land at the end of the tab list. Surface DB errors so
        // a transient lock/read failure doesn't collapse the next sort_order
        // to 0 and produce duplicate tab-order values.
        let sort_order: i32 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chat_sessions WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO chat_sessions
                (id, workspace_id, session_id, name, name_edited,
                 turn_count, sort_order, status)
             VALUES (?1, ?2, NULL, 'New chat', 0, 0, ?3, 'active')",
            params![id, workspace_id, sort_order],
        )?;
        self.get_chat_session(&id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn get_chat_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Option<ChatSession>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_sessions WHERE id = ?1",
            Self::CHAT_SESSION_COLS
        );
        self.conn
            .query_row(&sql, params![chat_session_id], Self::parse_chat_session_row)
            .optional()
    }

    /// List sessions for a workspace. `include_archived` toggles whether
    /// archived sessions are returned. Active sessions are always first,
    /// then archived; within each group, ordered by sort_order, then
    /// created_at as a stable tie-break.
    pub fn list_chat_sessions_for_workspace(
        &self,
        workspace_id: &str,
        include_archived: bool,
    ) -> Result<Vec<ChatSession>, rusqlite::Error> {
        let sql = if include_archived {
            format!(
                "SELECT {} FROM chat_sessions WHERE workspace_id = ?1
                 ORDER BY (status = 'archived'), sort_order, created_at",
                Self::CHAT_SESSION_COLS
            )
        } else {
            format!(
                "SELECT {} FROM chat_sessions
                 WHERE workspace_id = ?1 AND status = 'active'
                 ORDER BY sort_order, created_at",
                Self::CHAT_SESSION_COLS
            )
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_chat_session_row)?;
        rows.collect()
    }

    /// Rename a session. Sets `name_edited = 1` so Haiku auto-naming never
    /// overwrites the new name.
    pub fn rename_chat_session(
        &self,
        chat_session_id: &str,
        name: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions SET name = ?1, name_edited = 1 WHERE id = ?2",
            params![name, chat_session_id],
        )?;
        Ok(())
    }

    /// Write a Haiku-generated session name — only if the user has not
    /// already renamed the session. Returns `true` if the name was written.
    pub fn set_session_name_from_haiku(
        &self,
        chat_session_id: &str,
        name: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows = self.conn.execute(
            "UPDATE chat_sessions SET name = ?1
             WHERE id = ?2 AND name_edited = 0",
            params![name, chat_session_id],
        )?;
        Ok(rows > 0)
    }

    /// Persist per-session Claude CLI state so turns can be resumed after a
    /// restart. Replaces the old workspace-scoped `save_agent_session`.
    pub fn save_chat_session_state(
        &self,
        chat_session_id: &str,
        session_id: &str,
        turn_count: u32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions SET session_id = ?1, turn_count = ?2 WHERE id = ?3",
            params![session_id, turn_count, chat_session_id],
        )?;
        Ok(())
    }

    /// Clear Claude CLI state (e.g. after a reset or failed init).
    pub fn clear_chat_session_state(&self, chat_session_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions
             SET session_id = NULL, turn_count = 0 WHERE id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    /// Archive a session (soft-delete). Messages and checkpoints remain so
    /// they can be restored or purged later.
    pub fn archive_chat_session(&self, chat_session_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions
             SET status = 'archived', archived_at = datetime('now')
             WHERE id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    /// Archive a session while preserving the "workspace has ≥1 active
    /// session" invariant. Runs archive + remaining-count + conditional
    /// replacement create as a single transaction so observers never see a
    /// transient zero-sessions window and a crash mid-sequence can't persist
    /// a tab-less workspace. Returns the newly created session if a
    /// replacement was needed, `None` otherwise.
    pub fn archive_chat_session_ensuring_active(
        &self,
        chat_session_id: &str,
        workspace_id: &str,
    ) -> Result<Option<ChatSession>, rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE chat_sessions
             SET status = 'archived', archived_at = datetime('now')
             WHERE id = ?1",
            params![chat_session_id],
        )?;
        let remaining: i64 = tx.query_row(
            "SELECT COUNT(*) FROM chat_sessions
             WHERE workspace_id = ?1 AND status = 'active'",
            params![workspace_id],
            |row| row.get(0),
        )?;
        let fresh = if remaining == 0 {
            let sort_order: i32 = tx.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chat_sessions WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )?;
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO chat_sessions
                    (id, workspace_id, session_id, name, name_edited,
                     turn_count, sort_order, status)
                 VALUES (?1, ?2, NULL, 'New chat', 0, 0, ?3, 'active')",
                params![id, workspace_id, sort_order],
            )?;
            let sql = format!(
                "SELECT {} FROM chat_sessions WHERE id = ?1",
                Self::CHAT_SESSION_COLS
            );
            Some(tx.query_row(&sql, params![id], Self::parse_chat_session_row)?)
        } else {
            None
        };
        tx.commit()?;
        Ok(fresh)
    }

    /// Return the "default" session id for a workspace: the first active
    /// session, ordered by sort_order. Returns `None` when no active session
    /// exists (caller can create one to enforce the ≥1 invariant).
    pub fn default_session_id_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id FROM chat_sessions
                 WHERE workspace_id = ?1 AND status = 'active'
                 ORDER BY sort_order, created_at LIMIT 1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }

    /// Count of active sessions for a workspace. Used to enforce the
    /// "every workspace has ≥1 active session" invariant when archiving.
    pub fn active_session_count_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM chat_sessions
             WHERE workspace_id = ?1 AND status = 'active'",
            params![workspace_id],
            |row| row.get(0),
        )
    }

    /// Is this session the first (sort_order = 0) session for its workspace?
    /// Used to gate workspace-level branch auto-rename.
    pub fn is_initial_session(&self, chat_session_id: &str) -> Result<bool, rusqlite::Error> {
        let sort_order: Option<i32> = self
            .conn
            .query_row(
                "SELECT sort_order FROM chat_sessions WHERE id = ?1",
                params![chat_session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(sort_order == Some(0))
    }

    // --- Attachments ---

    pub fn insert_attachment(&self, att: &Attachment) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes, origin, tool_use_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                att.id,
                att.message_id,
                att.filename,
                att.media_type,
                att.data,
                att.width,
                att.height,
                att.size_bytes,
                att.origin.as_sql_str(),
                att.tool_use_id,
            ],
        )?;
        Ok(())
    }

    pub fn insert_attachments_batch(
        &self,
        attachments: &[Attachment],
    ) -> Result<(), rusqlite::Error> {
        if attachments.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for att in attachments {
            tx.execute(
                "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes, origin, tool_use_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    att.id,
                    att.message_id,
                    att.filename,
                    att.media_type,
                    att.data,
                    att.width,
                    att.height,
                    att.size_bytes,
                    att.origin.as_sql_str(),
                    att.tool_use_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_attachment(&self, id: &str) -> Result<Option<Attachment>, rusqlite::Error> {
        let sql = format!("SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1");
        self.conn
            .query_row(&sql, params![id], row_to_attachment)
            .optional()
    }

    pub fn list_attachments_for_message(
        &self,
        message_id: &str,
    ) -> Result<Vec<Attachment>, rusqlite::Error> {
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE message_id = ?1 ORDER BY created_at"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![message_id], row_to_attachment)?;
        rows.collect()
    }

    pub fn list_attachments_for_messages(
        &self,
        message_ids: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<Attachment>>, rusqlite::Error> {
        use std::collections::HashMap;

        let mut result: HashMap<String, Vec<Attachment>> = HashMap::new();
        if message_ids.is_empty() {
            return Ok(result);
        }

        // Build a parameterised IN clause.
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE message_id IN ({})
             ORDER BY created_at",
            placeholders.join(", ")
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = message_ids
            .iter()
            .map(|id| id as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = stmt.query_map(&*params, row_to_attachment)?;

        for att in rows {
            let att = att?;
            result.entry(att.message_id.clone()).or_default().push(att);
        }
        Ok(result)
    }

    /// List agent-authored attachments associated with a specific MCP
    /// `tool_use_id`. Returns rows ordered by creation time so multiple
    /// `send_to_user` calls within a single tool activity render in order.
    pub fn list_attachments_by_tool_use(
        &self,
        tool_use_id: &str,
    ) -> Result<Vec<Attachment>, rusqlite::Error> {
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments
             WHERE tool_use_id = ?1 AND origin = 'agent' ORDER BY created_at"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tool_use_id], row_to_attachment)?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::model::ChatRole;

    fn make_attachment(id: &str, message_id: &str, filename: &str) -> Attachment {
        Attachment {
            id: id.into(),
            message_id: message_id.into(),
            filename: filename.into(),
            media_type: "image/png".into(),
            data: vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG header
            width: Some(100),
            height: Some(200),
            size_bytes: 8,
            created_at: String::new(),
            origin: AttachmentOrigin::User,
            tool_use_id: None,
        }
    }

    // --- Chat message tests ---

    #[test]
    fn test_insert_and_list_chat_messages() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "hi there",
        ))
        .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].content, "hi there");
    }

    #[test]
    fn test_chat_messages_filtered_by_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "for w1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w2", ChatRole::User, "for w2"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "for w1");
    }

    #[test]
    fn test_update_chat_message_content() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m1",
            "w1",
            ChatRole::Assistant,
            "partial",
        ))
        .unwrap();
        db.update_chat_message_content("m1", "partial response complete")
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].content, "partial response complete");
    }

    #[test]
    fn test_update_chat_message_cost() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "done"))
            .unwrap();
        db.update_chat_message_cost("m1", 0.005, 2000).unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!((msgs[0].cost_usd.unwrap() - 0.005).abs() < f64::EPSILON);
        assert_eq!(msgs[0].duration_ms.unwrap(), 2000);
    }

    #[test]
    fn test_delete_chat_messages_for_workspace() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "msg2"))
            .unwrap();
        db.delete_chat_messages_for_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_messages_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "hi"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_message_role_roundtrip() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "user msg"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "asst msg",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::System, "sys msg"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].role, ChatRole::User);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        assert_eq!(msgs[2].role, ChatRole::System);
    }

    #[test]
    fn test_chat_message_tokens_round_trip() {
        let db = setup_db_with_workspace();
        let mut msg = make_chat_msg(&db, "mt1", "w1", ChatRole::Assistant, "hello");
        msg.input_tokens = Some(1234);
        msg.output_tokens = Some(56);
        msg.cache_read_tokens = Some(100_000);
        msg.cache_creation_tokens = Some(7_000);
        db.insert_chat_message(&msg).unwrap();

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].input_tokens, Some(1234));
        assert_eq!(msgs[0].output_tokens, Some(56));
        assert_eq!(msgs[0].cache_read_tokens, Some(100_000));
        assert_eq!(msgs[0].cache_creation_tokens, Some(7_000));
    }

    #[test]
    fn test_chat_message_tokens_null_round_trip() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "mt2", "w1", ChatRole::Assistant, "hi"))
            .unwrap();

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].input_tokens, None);
        assert_eq!(msgs[0].output_tokens, None);
        assert_eq!(msgs[0].cache_read_tokens, None);
        assert_eq!(msgs[0].cache_creation_tokens, None);
    }

    // --- Attachment tests ---

    #[test]
    fn test_insert_and_list_attachments() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m1",
            "w1",
            ChatRole::User,
            "look at this",
        ))
        .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "screenshot.png"))
            .unwrap();

        let atts = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0].id, "a1");
        assert_eq!(atts[0].filename, "screenshot.png");
        assert_eq!(atts[0].media_type, "image/png");
        assert_eq!(
            atts[0].data,
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
        assert_eq!(atts[0].width, Some(100));
        assert_eq!(atts[0].height, Some(200));
        assert_eq!(atts[0].size_bytes, 8);
    }

    #[test]
    fn test_attachment_cascade_on_message_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "img"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "pic.png"))
            .unwrap();

        // Deleting all messages for the workspace should cascade to attachments.
        db.delete_chat_messages_for_workspace("w1").unwrap();
        let atts = db.list_attachments_for_message("m1").unwrap();
        assert!(atts.is_empty());
    }

    #[test]
    fn test_attachment_cascade_on_delete_messages_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "first.png"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::User, "second"))
            .unwrap();
        db.insert_attachment(&make_attachment("a2", "m2", "second.png"))
            .unwrap();

        // Delete messages after m1 — m2 and its attachment should be gone.
        db.delete_messages_after("w1", "m1").unwrap();

        let atts_m1 = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts_m1.len(), 1, "first message attachment should survive");
        let atts_m2 = db.list_attachments_for_message("m2").unwrap();
        assert!(
            atts_m2.is_empty(),
            "second message attachment should be deleted"
        );
    }

    #[test]
    fn test_insert_attachments_batch() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "images"))
            .unwrap();

        let attachments = vec![
            make_attachment("a1", "m1", "one.png"),
            make_attachment("a2", "m1", "two.jpg"),
            make_attachment("a3", "m1", "three.gif"),
        ];
        db.insert_attachments_batch(&attachments).unwrap();

        let atts = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts.len(), 3);
    }

    #[test]
    fn test_insert_attachments_batch_empty() {
        let db = setup_db_with_workspace();
        // Should be a no-op, not an error.
        db.insert_attachments_batch(&[]).unwrap();
    }

    #[test]
    fn test_get_attachment_by_id() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "doc.pdf"))
            .unwrap();

        let att = db.get_attachment("a1").unwrap().unwrap();
        assert_eq!(att.filename, "doc.pdf");
        assert_eq!(att.data.len(), 8); // PNG header bytes from make_attachment
    }

    #[test]
    fn test_get_attachment_not_found() {
        let db = setup_db_with_workspace();
        let result = db.get_attachment("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_list_attachments_for_messages_batch() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::User, "msg2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "msg3"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "pic1.png"))
            .unwrap();
        db.insert_attachment(&make_attachment("a2", "m1", "pic2.png"))
            .unwrap();
        db.insert_attachment(&make_attachment("a3", "m2", "pic3.jpg"))
            .unwrap();
        // m3 has no attachments.

        let ids = vec!["m1".into(), "m2".into(), "m3".into()];
        let map = db.list_attachments_for_messages(&ids).unwrap();

        assert_eq!(map.get("m1").map(|v| v.len()), Some(2));
        assert_eq!(map.get("m2").map(|v| v.len()), Some(1));
        assert!(!map.contains_key("m3"), "m3 should have no entry");
    }

    #[test]
    fn test_insert_agent_attachment_round_trips_with_tool_use_id() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "here"))
            .unwrap();
        let att = Attachment {
            id: "ag1".into(),
            message_id: "m1".into(),
            filename: "shot.png".into(),
            media_type: "image/png".into(),
            data: vec![0x89, 0x50, 0x4E, 0x47],
            width: Some(640),
            height: Some(480),
            size_bytes: 4,
            created_at: String::new(),
            origin: AttachmentOrigin::Agent,
            tool_use_id: Some("toolu_42".into()),
        };
        db.insert_attachment(&att).unwrap();

        let got = db.get_attachment("ag1").unwrap().unwrap();
        assert_eq!(got.origin, AttachmentOrigin::Agent);
        assert_eq!(got.tool_use_id.as_deref(), Some("toolu_42"));
        assert_eq!(got.filename, "shot.png");
        assert_eq!(got.size_bytes, 4);
    }

    #[test]
    fn test_list_attachments_by_tool_use_id_filters_correctly() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "x"))
            .unwrap();
        let mk = |id: &str, tuid: Option<&str>| Attachment {
            id: id.into(),
            message_id: "m1".into(),
            filename: format!("{id}.png"),
            media_type: "image/png".into(),
            data: vec![0],
            width: None,
            height: None,
            size_bytes: 1,
            created_at: String::new(),
            origin: AttachmentOrigin::Agent,
            tool_use_id: tuid.map(String::from),
        };
        db.insert_attachment(&mk("a1", Some("toolu_1"))).unwrap();
        db.insert_attachment(&mk("a2", Some("toolu_1"))).unwrap();
        db.insert_attachment(&mk("a3", Some("toolu_2"))).unwrap();
        db.insert_attachment(&mk("a4", None)).unwrap();

        let one = db.list_attachments_by_tool_use("toolu_1").unwrap();
        assert_eq!(one.len(), 2);
        assert!(
            one.iter()
                .all(|a| a.tool_use_id.as_deref() == Some("toolu_1"))
        );

        let two = db.list_attachments_by_tool_use("toolu_2").unwrap();
        assert_eq!(two.len(), 1);

        let none = db.list_attachments_by_tool_use("missing").unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn test_existing_user_attachment_loads_with_user_origin() {
        // Verifies row_to_attachment correctly populates origin for legacy
        // rows inserted via the User-shaped path.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hi"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "u.png"))
            .unwrap();
        let got = db.get_attachment("a1").unwrap().unwrap();
        assert_eq!(got.origin, AttachmentOrigin::User);
        assert!(got.tool_use_id.is_none());
    }

    #[test]
    fn test_attachments_origin_defaults_to_user_for_existing_rows() {
        // Migration adds `origin TEXT NOT NULL DEFAULT 'user'` so any pre-
        // existing row is implicitly user-supplied without a backfill step.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "img"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "u.png"))
            .unwrap();

        let origin: String = db
            .conn
            .query_row(
                "SELECT origin FROM attachments WHERE id = ?1",
                params!["a1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(origin, "user");

        let tool_use_id: Option<String> = db
            .conn
            .query_row(
                "SELECT tool_use_id FROM attachments WHERE id = ?1",
                params!["a1"],
                |r| r.get(0),
            )
            .unwrap();
        assert!(tool_use_id.is_none());
    }

    #[test]
    fn test_attachments_origin_check_rejects_invalid_values() {
        // The CHECK constraint enforces origin ∈ {'user','agent'}; arbitrary
        // strings must be rejected at write time so the column can be trusted
        // as an enum from Rust's side.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "x"))
            .unwrap();
        let res = db.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, size_bytes, origin)
             VALUES ('a1', 'm1', 'x.png', 'image/png', x'00', 1, 'bogus')",
            [],
        );
        assert!(res.is_err(), "CHECK should reject bogus origin");
    }

    #[test]
    fn test_attachments_can_insert_agent_origin_with_tool_use_id() {
        // Direct-SQL canary: confirms an agent-origin row with a tool_use_id
        // can be written. The Rust API for this lands in slice 2.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "here"))
            .unwrap();
        db.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, size_bytes, origin, tool_use_id)
             VALUES ('a1', 'm1', 'shot.png', 'image/png', x'89504E47', 4, 'agent', 'toolu_123')",
            [],
        ).unwrap();

        let (origin, tool_use_id): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT origin, tool_use_id FROM attachments WHERE id = 'a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "agent");
        assert_eq!(tool_use_id.as_deref(), Some("toolu_123"));
    }

    #[test]
    fn test_last_message_per_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "second",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m3",
            "w2",
            ChatRole::User,
            "other workspace",
        ))
        .unwrap();

        let last = db.last_message_per_workspace().unwrap();
        assert_eq!(last.len(), 2);

        let w1_msg = last.iter().find(|m| m.workspace_id == "w1").unwrap();
        assert_eq!(w1_msg.content, "second");

        let w2_msg = last.iter().find(|m| m.workspace_id == "w2").unwrap();
        assert_eq!(w2_msg.content, "other workspace");
    }

    #[test]
    fn test_last_message_per_workspace_same_timestamp() {
        let db = setup_db_with_workspace();
        // Insert two messages with identical timestamps — the later rowid should win.
        let mut m1 = make_chat_msg(&db, "m1", "w1", ChatRole::User, "first");
        m1.created_at = "2026-01-01 00:00:00".into();
        let mut m2 = make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "second");
        m2.created_at = "2026-01-01 00:00:00".into();
        db.insert_chat_message(&m1).unwrap();
        db.insert_chat_message(&m2).unwrap();

        let last = db.last_message_per_workspace().unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0].content, "second");
    }

    #[test]
    fn test_last_message_empty_when_no_messages() {
        let db = setup_db_with_workspace();
        let last = db.last_message_per_workspace().unwrap();
        assert!(last.is_empty());
    }

    /// Regression: an unknown `role` string in the `chat_messages` table must
    /// surface as a `FromSqlConversionFailure`, not silently become
    /// `ChatRole::User`. See issue #485.
    ///
    /// We bypass the table's `CHECK(role IN (...))` constraint via
    /// `PRAGMA ignore_check_constraints` so this test can simulate corrupted
    /// data or a future-version row whose role string post-dates the CHECK.
    #[test]
    fn test_list_chat_messages_unknown_role_returns_error() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hi"))
            .unwrap();
        db.conn
            .execute_batch("PRAGMA ignore_check_constraints = ON;")
            .unwrap();
        db.conn
            .execute(
                "UPDATE chat_messages SET role = 'unknown_role' WHERE id = 'm1'",
                [],
            )
            .unwrap();
        let result = db.list_chat_messages("w1");
        match result {
            Err(rusqlite::Error::FromSqlConversionFailure(idx, ty, _)) => {
                assert_eq!(idx, 3, "expected chat_messages.role column index 3");
                assert_eq!(
                    ty,
                    rusqlite::types::Type::Text,
                    "expected chat_messages.role to be reported as TEXT"
                );
            }
            other => panic!("expected FromSqlConversionFailure for unknown role, got: {other:?}",),
        }
    }

    /// Regression: an unknown `status` string in the `chat_sessions` table
    /// must surface as a `FromSqlConversionFailure`, not silently coerce to
    /// `SessionStatus::Active`. See issue #485.
    #[test]
    fn test_list_chat_sessions_unknown_status_returns_error() {
        let db = setup_db_with_workspace();
        // The workspace was seeded with a default chat session — corrupt its status.
        db.conn
            .execute(
                "UPDATE chat_sessions SET status = 'pending' WHERE workspace_id = 'w1'",
                [],
            )
            .unwrap();
        // include_archived = true so the WHERE filter doesn't pre-exclude the
        // corrupt row before parse_chat_session_row gets a chance to see it.
        let result = db.list_chat_sessions_for_workspace("w1", true);
        match result {
            Err(rusqlite::Error::FromSqlConversionFailure(idx, ty, _)) => {
                assert_eq!(idx, 7, "expected chat_sessions.status column index 7");
                assert_eq!(
                    ty,
                    rusqlite::types::Type::Text,
                    "expected chat_sessions.status to be reported as TEXT"
                );
            }
            other => panic!(
                "expected FromSqlConversionFailure for unknown session status, got: {other:?}",
            ),
        }
    }
}
