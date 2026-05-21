//! Conversation checkpoint and rollback CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::model::{
    ChatMessage, CheckpointFile, CompletedTurnData, ConversationCheckpoint, TurnToolActivity,
};

use super::Database;

/// Hex sha256 digest of `bytes`. The blob store keys on this string — it's
/// hex-not-binary because SQLite's TEXT primary key behaves more predictably
/// across collations and dumps than a BLOB primary key would.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

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
        self.gc_orphan_blobs_after_delete(deleted);
        self.best_effort_incremental_vacuum_after_delete(deleted);
        Ok(deleted)
    }

    pub fn delete_checkpoint(&self, checkpoint_id: &str) -> Result<(), rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE id = ?1",
            params![checkpoint_id],
        )?;
        self.gc_orphan_blobs_after_delete(deleted);
        self.best_effort_incremental_vacuum_after_delete(deleted);
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
        self.gc_orphan_blobs_after_delete(deleted);
        self.best_effort_incremental_vacuum_after_delete(deleted);
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

    /// Insert a batch of snapshot rows. Each row's bytes are deduplicated
    /// into `checkpoint_blobs` keyed by sha256; the row itself stores only
    /// the hash reference. Callers may pass either pre-hashed rows
    /// (`blob_sha256: Some(..)`, `content: Some(bytes)`) — the typical
    /// snapshot path — or legacy-style rows with only `content`, in which
    /// case the hash is computed here.
    ///
    /// New callers should prefer [`Self::insert_checkpoint_files_and_prune`]
    /// which additionally enforces the per-workspace retention cap and runs
    /// orphan blob GC in the same transaction. This bare variant is kept for
    /// the fork code path, which copies references rather than fresh bytes.
    pub fn insert_checkpoint_files(&self, files: &[CheckpointFile]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        Self::insert_checkpoint_files_tx(&tx, files)?;
        tx.commit()?;
        Ok(())
    }

    /// Insert snapshot rows, prune `checkpoint_files` for any checkpoint
    /// beyond `retention_count` most-recent for the workspace, and orphan-GC
    /// `checkpoint_blobs` — all in a single transaction.
    ///
    /// Pruning targets `checkpoint_files` rows only; the
    /// `conversation_checkpoints` and `turn_tool_activities` rows for older
    /// checkpoints survive so chat history stays intact. `has_file_state` is
    /// a derived `EXISTS(...)` column over `checkpoint_files`, so it
    /// auto-flips to `false` for pruned checkpoints and the restore path's
    /// existing guard (`src-tauri/src/commands/chat/checkpoint.rs`)
    /// short-circuits as a safe no-op.
    pub fn insert_checkpoint_files_and_prune(
        &self,
        workspace_id: &str,
        files: &[CheckpointFile],
        retention_count: usize,
    ) -> Result<(), rusqlite::Error> {
        let keep = retention_count.max(1);
        let tx = self.conn.unchecked_transaction()?;
        Self::insert_checkpoint_files_tx(&tx, files)?;
        Self::prune_checkpoint_files_tx(&tx, workspace_id, keep)?;
        Self::gc_orphan_blobs_tx(&tx)?;
        tx.commit()?;
        Ok(())
    }

    fn insert_checkpoint_files_tx(
        tx: &rusqlite::Transaction<'_>,
        files: &[CheckpointFile],
    ) -> Result<(), rusqlite::Error> {
        let mut upsert_blob = tx.prepare(
            "INSERT INTO checkpoint_blobs (sha256, bytes, byte_size, compression)
             VALUES (?1, ?2, ?3, 'none')
             ON CONFLICT(sha256) DO NOTHING",
        )?;
        let mut insert_file = tx.prepare(
            "INSERT INTO checkpoint_files (id, checkpoint_id, file_path, blob_sha256, file_mode)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for f in files {
            let sha = match (&f.blob_sha256, &f.content) {
                (Some(sha), _) => sha.clone(),
                (None, Some(bytes)) => sha256_hex(bytes),
                (None, None) => {
                    // Tombstone-style row with no content and no hash —
                    // historically unused, preserved here as a no-bytes row.
                    insert_file.execute(params![
                        f.id,
                        f.checkpoint_id,
                        f.file_path,
                        Option::<String>::None,
                        f.file_mode,
                    ])?;
                    continue;
                }
            };
            if let Some(bytes) = &f.content {
                upsert_blob.execute(params![sha, bytes, bytes.len() as i64])?;
            }
            insert_file.execute(params![
                f.id,
                f.checkpoint_id,
                f.file_path,
                sha,
                f.file_mode,
            ])?;
        }
        Ok(())
    }

    fn prune_checkpoint_files_tx(
        tx: &rusqlite::Transaction<'_>,
        workspace_id: &str,
        keep: usize,
    ) -> Result<(), rusqlite::Error> {
        // `created_at DESC, turn_index DESC, id DESC` matches the ordering
        // documented in #582: created_at is unambiguous wall-clock recency at
        // the workspace scope (turn_index is per-session so it collides
        // across sessions), id is the deterministic final tiebreaker.
        //
        // The `EXISTS(...)` filter scopes the subquery to checkpoints that
        // still hold file rows. Without it, a workspace with thousands of
        // historical turns re-scans every old checkpoint on every
        // snapshot even though their `checkpoint_files` rows were already
        // pruned earlier and there is no work to do for them — making
        // snapshot cost O(total history) rather than O(retained-with-files).
        tx.execute(
            "DELETE FROM checkpoint_files
             WHERE checkpoint_id IN (
                 SELECT id FROM conversation_checkpoints
                  WHERE workspace_id = ?1
                    AND EXISTS(
                        SELECT 1 FROM checkpoint_files
                         WHERE checkpoint_id = conversation_checkpoints.id
                    )
                  ORDER BY created_at DESC, turn_index DESC, id DESC
                  LIMIT -1 OFFSET ?2
             )",
            params![workspace_id, keep as i64],
        )?;
        Ok(())
    }

    fn gc_orphan_blobs_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
        // Correlated `NOT EXISTS` lets SQLite drive each candidate blob row
        // through `idx_checkpoint_files_blob_sha256` directly, without
        // materializing a DISTINCT set of every referenced sha. Also avoids
        // any `NOT IN` NULL surprise if a future schema change ever
        // dropped the `IS NOT NULL` guard.
        tx.execute(
            "DELETE FROM checkpoint_blobs
             WHERE NOT EXISTS (
                 SELECT 1 FROM checkpoint_files
                  WHERE blob_sha256 = checkpoint_blobs.sha256
             )",
            [],
        )?;
        Ok(())
    }

    /// Read snapshot rows for a checkpoint, materializing bytes from
    /// `checkpoint_blobs` via the `blob_sha256` reference. Legacy rows
    /// where `blob_sha256 IS NULL` fall back to the row's own `content`
    /// column (un-backfilled writes from before #940 / #942 dedupe).
    pub fn get_checkpoint_files(
        &self,
        checkpoint_id: &str,
    ) -> Result<Vec<CheckpointFile>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT cf.id, cf.checkpoint_id, cf.file_path, cf.file_mode,
                    cf.blob_sha256, cf.content, b.bytes
             FROM checkpoint_files cf
             LEFT JOIN checkpoint_blobs b ON b.sha256 = cf.blob_sha256
             WHERE cf.checkpoint_id = ?1",
        )?;
        let rows = stmt.query_map(params![checkpoint_id], |row| {
            let blob_sha256: Option<String> = row.get(4)?;
            let legacy_content: Option<Vec<u8>> = row.get(5)?;
            let blob_bytes: Option<Vec<u8>> = row.get(6)?;
            // Prefer blob bytes when the row has been deduped/backfilled;
            // fall back to the row's own column for legacy un-backfilled rows.
            let content = blob_bytes.or(legacy_content);
            Ok(CheckpointFile {
                id: row.get(0)?,
                checkpoint_id: row.get(1)?,
                file_path: row.get(2)?,
                file_mode: row.get(3)?,
                blob_sha256,
                content,
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

    /// Count legacy `checkpoint_files` rows that still hold raw bytes in
    /// the `content` column and haven't been migrated to the
    /// content-addressed `checkpoint_blobs` store yet. Used by the startup
    /// backfill to decide whether work is needed at all.
    pub fn count_legacy_checkpoint_file_rows(&self) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM checkpoint_files
             WHERE content IS NOT NULL AND blob_sha256 IS NULL",
            [],
            |r| r.get(0),
        )
    }

    /// Migrate a bounded batch of legacy rows into `checkpoint_blobs`.
    /// Picks up to `max_rows` rows (or as many as fit within `max_bytes`
    /// of total content, whichever budget is hit first), hashes each one,
    /// upserts the bytes into `checkpoint_blobs`, then rewrites the
    /// `checkpoint_files` row to reference the hash and null its `content`.
    /// Returns the number of rows migrated; 0 means the work is done.
    ///
    /// Each call is its own transaction so a long-running backfill can't
    /// lose progress on shutdown.
    pub fn migrate_legacy_checkpoint_file_batch(
        &self,
        max_rows: usize,
        max_bytes: usize,
    ) -> Result<usize, rusqlite::Error> {
        let rows: Vec<(String, Vec<u8>)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, content FROM checkpoint_files
                 WHERE content IS NOT NULL AND blob_sha256 IS NULL
                 ORDER BY rowid
                 LIMIT ?1",
            )?;
            let mut acc: Vec<(String, Vec<u8>)> = Vec::new();
            let mut bytes_so_far: usize = 0;
            let iter = stmt.query_map(params![max_rows as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })?;
            for row in iter {
                let (id, content) = row?;
                bytes_so_far = bytes_so_far.saturating_add(content.len());
                acc.push((id, content));
                if bytes_so_far >= max_bytes {
                    break;
                }
            }
            acc
        };

        if rows.is_empty() {
            return Ok(0);
        }

        let migrated = rows.len();
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut upsert_blob = tx.prepare(
                "INSERT INTO checkpoint_blobs (sha256, bytes, byte_size, compression)
                 VALUES (?1, ?2, ?3, 'none')
                 ON CONFLICT(sha256) DO NOTHING",
            )?;
            let mut update_file = tx.prepare(
                "UPDATE checkpoint_files
                    SET blob_sha256 = ?1, content = NULL
                  WHERE id = ?2",
            )?;
            for (id, content) in &rows {
                let sha = sha256_hex(content);
                upsert_blob.execute(params![sha, content, content.len() as i64])?;
                update_file.execute(params![sha, id])?;
            }
        }
        tx.commit()?;
        Ok(migrated)
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
        self.best_effort_incremental_vacuum_after_delete(deleted);
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
        self.best_effort_incremental_vacuum_after_delete(deleted);
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
    use crate::model::{ChatRole, CheckpointFile};

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

    /// Regression pin for #908: deleting a checkpoint via the application
    /// path must actually reclaim the BLOB pages, not just the (now small)
    /// reference rows. With dedupe in place, bytes live in `checkpoint_blobs`
    /// — so the invariant we care about is that the blob row goes away
    /// and the DB file shrinks below its pre-delete size after vacuum
    /// reclaims the tail pages.
    #[test]
    fn test_delete_checkpoint_reclaims_checkpoint_blob_pages() {
        fn setup_checkpoint_file_db() -> (tempfile::TempDir, Database) {
            let dir = tempfile::tempdir().unwrap();
            let db = Database::open(&dir.path().join("claudette.db")).unwrap();
            db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
                .unwrap();
            db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
                .unwrap();
            db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
                .unwrap();
            db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
                .unwrap();
            db.insert_checkpoint_files(&[CheckpointFile {
                id: "cf1".into(),
                checkpoint_id: "cp1".into(),
                file_path: "large.bin".into(),
                content: Some(vec![7; 1024 * 1024]),
                blob_sha256: None,
                file_mode: 0o100644,
            }])
            .unwrap();
            (dir, db)
        }

        // Raw cascade deletion (no application-level GC) leaves the blob
        // row alive — the FK cascade only touches `checkpoint_files`.
        let (_raw_dir, raw_db) = setup_checkpoint_file_db();
        raw_db
            .conn()
            .execute("DELETE FROM conversation_checkpoints WHERE id = 'cp1'", [])
            .unwrap();
        let raw_blob_count = blob_count(&raw_db);
        assert_eq!(
            raw_blob_count, 1,
            "raw cascade must leave the blob row alive — only application-level GC reclaims it"
        );

        // Application-level delete chains through orphan-blob GC, dropping
        // the bytes for real. `incremental_vacuum` only reclaims pages at
        // the tail of the database file (a SQLite policy), so the freelist
        // count is not a reliable signal under WAL mode — what we pin here
        // is the durable invariant: the blob row is gone.
        let (_vacuum_dir, vacuum_db) = setup_checkpoint_file_db();
        vacuum_db.delete_checkpoint("cp1").unwrap();
        assert_eq!(
            blob_count(&vacuum_db),
            0,
            "delete_checkpoint must orphan-GC unreferenced blobs"
        );
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

    // --- Dedupe + retention regression pins (#940 / #942) ---

    fn raw_file(id: &str, cp: &str, path: &str, bytes: &[u8]) -> CheckpointFile {
        CheckpointFile {
            id: id.into(),
            checkpoint_id: cp.into(),
            file_path: path.into(),
            content: Some(bytes.to_vec()),
            blob_sha256: None,
            file_mode: 0o100644,
        }
    }

    fn blob_count(db: &Database) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM checkpoint_blobs", [], |r| r.get(0))
            .unwrap()
    }

    fn checkpoint_files_count(db: &Database) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM checkpoint_files", [], |r| r.get(0))
            .unwrap()
    }

    /// Regression pin for #940 / #942: the same bytes written into N different
    /// checkpoints must collapse to ONE row in `checkpoint_blobs`, with each
    /// `checkpoint_files` row pointing at the shared hash.
    #[test]
    fn dedupe_collapses_identical_blobs_across_checkpoints() {
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

        // Same 1 MB blob written into three checkpoints under both
        // `image.png` and `image-copy.png` (6 reference rows total).
        let bytes = vec![42u8; 1024 * 1024];
        for cp in ["cp1", "cp2", "cp3"] {
            for (suffix, path) in [("a", "image.png"), ("b", "image-copy.png")] {
                let id = format!("f-{cp}-{suffix}");
                db.insert_checkpoint_files(&[raw_file(&id, cp, path, &bytes)])
                    .unwrap();
            }
        }

        assert_eq!(blob_count(&db), 1, "identical bytes must dedupe to 1 blob");
        // 6 file rows (3 checkpoints × 2 paths) all reference that blob.
        let referencing: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM checkpoint_files WHERE blob_sha256 IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(referencing, 6);
    }

    /// The read path must materialize bytes from `checkpoint_blobs` even
    /// though `checkpoint_files.content` is NULL — this is what rollback /
    /// restore relies on.
    #[test]
    fn read_path_materializes_bytes_via_blob_join() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        db.insert_checkpoint_files(&[raw_file("f1", "cp1", "x.txt", b"hello world")])
            .unwrap();

        // Sanity: the row itself doesn't carry bytes anymore.
        let raw_content: Option<Vec<u8>> = db
            .conn()
            .query_row(
                "SELECT content FROM checkpoint_files WHERE id = 'f1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            raw_content.is_none(),
            "dedupe path must null the legacy content column"
        );

        // Read path joins back through checkpoint_blobs.
        let files = db.get_checkpoint_files("cp1").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content.as_deref(), Some(b"hello world".as_ref()));
        assert!(files[0].blob_sha256.is_some());
    }

    /// Legacy un-backfilled rows (content present, blob_sha256 NULL) must
    /// still be readable so a partially-migrated DB doesn't lose restore.
    #[test]
    fn read_path_falls_back_to_legacy_content_column() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        // Backdoor a legacy-style row: bytes in `content`, no blob ref. This
        // is what an un-backfilled pre-dedupe DB looks like.
        db.execute_batch(
            "INSERT INTO checkpoint_files
                (id, checkpoint_id, file_path, content, blob_sha256, file_mode)
             VALUES ('legacy', 'cp1', 'legacy.txt', x'6c6567616379', NULL, 33188);",
        )
        .unwrap();

        let files = db.get_checkpoint_files("cp1").unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content.as_deref(), Some(b"legacy".as_ref()));
        assert!(files[0].blob_sha256.is_none());
    }

    /// `insert_checkpoint_files_and_prune` keeps the N most-recent
    /// checkpoints' files for the workspace and drops file rows from older
    /// ones. The `conversation_checkpoints` and `turn_tool_activities` rows
    /// must survive so chat history isn't lost.
    #[test]
    fn retention_prunes_old_file_rows_but_keeps_history() {
        let db = setup_db_with_workspace();
        for i in 0..5 {
            let mid = format!("m{i}");
            let cpid = format!("cp{i}");
            db.insert_chat_message(&make_chat_msg(&db, &mid, "w1", ChatRole::Assistant, "x"))
                .unwrap();
            db.insert_checkpoint(&make_checkpoint(&db, &cpid, "w1", &mid, i))
                .unwrap();
            db.insert_turn_tool_activities(&[make_tool_activity(
                &format!("a{i}"),
                &cpid,
                "Read",
                0,
            )])
            .unwrap();
        }

        // Snapshot some files into each checkpoint via the retention path,
        // keep=2. After all five inserts, only cp3 + cp4 should retain file
        // rows. cp0–cp2 keep their checkpoint + activity rows but lose
        // file restoreability.
        for i in 0..5 {
            let cpid = format!("cp{i}");
            let fid = format!("f-{i}");
            db.insert_checkpoint_files_and_prune(
                "w1",
                &[raw_file(
                    &fid,
                    &cpid,
                    "a.txt",
                    format!("content-{i}").as_bytes(),
                )],
                2,
            )
            .unwrap();
        }

        let file_rows: Vec<String> = {
            let mut stmt = db
                .conn()
                .prepare("SELECT checkpoint_id FROM checkpoint_files ORDER BY checkpoint_id")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            file_rows,
            vec!["cp3".to_string(), "cp4".to_string()],
            "retention=2 must drop file rows for cp0–cp2"
        );

        // Checkpoint rows + activities for the pruned checkpoints survive:
        // chat history continues to show them, only restoreability is gone.
        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 5);

        // Pruned checkpoints flip `has_file_state` to false automatically
        // because it's derived as EXISTS over checkpoint_files.
        let cp0 = db.get_checkpoint("cp0").unwrap().unwrap();
        assert!(!cp0.has_file_state);
        let cp4 = db.get_checkpoint("cp4").unwrap().unwrap();
        assert!(cp4.has_file_state);
    }

    /// Blobs only referenced by pruned `checkpoint_files` rows must be
    /// GC'd in the same transaction so retention actually reclaims space.
    #[test]
    fn retention_garbage_collects_orphaned_blobs() {
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

        // Each checkpoint touches a unique blob.
        db.insert_checkpoint_files_and_prune("w1", &[raw_file("f1", "cp1", "x.bin", b"AAAA")], 10)
            .unwrap();
        db.insert_checkpoint_files_and_prune("w1", &[raw_file("f2", "cp2", "x.bin", b"BBBB")], 10)
            .unwrap();
        db.insert_checkpoint_files_and_prune("w1", &[raw_file("f3", "cp3", "x.bin", b"CCCC")], 10)
            .unwrap();
        assert_eq!(blob_count(&db), 3);

        // Tighten retention to 1 — the next insert prunes cp1 and cp2's
        // file rows and GCs their now-orphan blobs in the same transaction.
        db.insert_checkpoint_files_and_prune(
            "w1",
            &[raw_file("f3-take2", "cp3", "y.bin", b"DDDD")],
            1,
        )
        .unwrap();
        // cp3 retains two file rows (x.bin AAAA-style... no, CCCC for cp3 + DDDD).
        // Only cp3's blobs survive (CCCC + DDDD); cp1/cp2 (AAAA/BBBB) are GC'd.
        assert_eq!(blob_count(&db), 2);
    }

    /// `delete_checkpoint` cascades through `checkpoint_files` via the FK
    /// and then orphan-GCs `checkpoint_blobs` so blob bytes are reclaimed
    /// (not just the reference rows).
    #[test]
    fn delete_checkpoint_orphan_gcs_blobs() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint_files(&[raw_file("f1", "cp1", "x.bin", b"ZZZZ")])
            .unwrap();
        assert_eq!(blob_count(&db), 1);

        db.delete_checkpoint("cp1").unwrap();

        assert_eq!(checkpoint_files_count(&db), 0);
        assert_eq!(
            blob_count(&db),
            0,
            "blob bytes must be reclaimed when no checkpoint_files row references them"
        );
    }

    /// Codex peer-review pin: the retention prune subquery must skip
    /// checkpoints whose file rows were already pruned in a previous run.
    /// Without the `EXISTS(...)` filter, the subquery returns every
    /// historical checkpoint past the offset on every snapshot — making
    /// the per-snapshot cost O(workspace lifetime) instead of
    /// O(retained-with-files).
    #[test]
    fn retention_prune_subquery_skips_already_pruned_checkpoints() {
        let db = setup_db_with_workspace();
        // Seed N+2 checkpoints, all with file rows. After a tight
        // retention pass, only the N most-recent should still have files.
        for i in 0..5 {
            let mid = format!("m{i}");
            let cpid = format!("cp{i}");
            db.insert_chat_message(&make_chat_msg(&db, &mid, "w1", ChatRole::Assistant, "x"))
                .unwrap();
            db.insert_checkpoint(&make_checkpoint(&db, &cpid, "w1", &mid, i))
                .unwrap();
            db.insert_checkpoint_files_and_prune(
                "w1",
                &[raw_file(&format!("f-{i}"), &cpid, "a.txt", b"x")],
                2,
            )
            .unwrap();
        }

        // EXPLAIN QUERY PLAN must consult `checkpoint_files` from the
        // inner EXISTS filter — proving the new index path is in play
        // and the subquery is bounded by the retained set.
        let plan: Vec<String> = {
            let mut stmt = db
                .conn()
                .prepare(
                    "EXPLAIN QUERY PLAN
                     DELETE FROM checkpoint_files
                      WHERE checkpoint_id IN (
                          SELECT id FROM conversation_checkpoints
                           WHERE workspace_id = 'w1'
                             AND EXISTS(
                                 SELECT 1 FROM checkpoint_files
                                  WHERE checkpoint_id = conversation_checkpoints.id
                             )
                           ORDER BY created_at DESC, turn_index DESC, id DESC
                           LIMIT -1 OFFSET 2
                      )",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let plan_text = plan.join(" | ");
        assert!(
            plan_text.contains("checkpoint_files"),
            "EXISTS filter must drive a checkpoint_files lookup in the plan: {plan_text}"
        );

        // And the retention semantics still hold — cp3 + cp4 keep files,
        // cp0–cp2 don't. (Same invariant as
        // `retention_prunes_old_file_rows_but_keeps_history`, but here it
        // doubles as a sanity check that the EXISTS filter didn't change
        // the semantic outcome — only the cost.)
        let with_files: Vec<String> = {
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT DISTINCT checkpoint_id FROM checkpoint_files
                     ORDER BY checkpoint_id",
                )
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(with_files, vec!["cp3".to_string(), "cp4".to_string()]);
    }
}
