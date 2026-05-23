use chrono::{DateTime, Utc};
use rusqlite::{OptionalExtension, params};

use crate::scheduling::{ScheduledTask, ScheduledTaskKind, next_cron_run_utc, utc_now_rfc3339};

use super::Database;

impl Database {
    pub fn create_agent_wakeup(
        &self,
        chat_session_id: &str,
        fire_at: DateTime<Utc>,
        prompt: &str,
        reason: Option<&str>,
        backend_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<ScheduledTask, rusqlite::Error> {
        let workspace_id = self.workspace_id_for_chat_session(chat_session_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = utc_now_rfc3339();
        let fire_at = fire_at.to_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_scheduled_tasks
                (id, chat_session_id, workspace_id, kind, prompt, reason, fire_at,
                 recurring, enabled, created_at, updated_at, next_fire_at,
                 backend_id, model)
             VALUES (?1, ?2, ?3, 'wakeup', ?4, ?5, ?6, 0, 1, ?7, ?7, ?6, ?8, ?9)",
            params![
                id,
                chat_session_id,
                workspace_id,
                prompt,
                reason,
                fire_at,
                now,
                backend_id.map(str::trim).filter(|s| !s.is_empty()),
                model.map(str::trim).filter(|s| !s.is_empty()),
            ],
        )?;
        self.get_agent_scheduled_task(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_agent_cron_task(
        &self,
        chat_session_id: &str,
        name: Option<&str>,
        cron_expr: &str,
        prompt: &str,
        recurring: bool,
        backend_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<ScheduledTask, rusqlite::Error> {
        let workspace_id = self.workspace_id_for_chat_session(chat_session_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now_dt = Utc::now();
        let next = next_cron_run_utc(cron_expr, now_dt).ok_or_else(|| {
            rusqlite::Error::InvalidParameterName(format!(
                "invalid cron expression or no fire time in next year: {cron_expr}"
            ))
        })?;
        let now = now_dt.to_rfc3339();
        let next = next.to_rfc3339();
        self.conn.execute(
            "INSERT INTO agent_scheduled_tasks
                (id, chat_session_id, workspace_id, kind, name, prompt, cron_expr,
                 recurring, enabled, created_at, updated_at, next_fire_at,
                 backend_id, model)
             VALUES (?1, ?2, ?3, 'cron', ?4, ?5, ?6, ?7, 1, ?8, ?8, ?9, ?10, ?11)",
            params![
                id,
                chat_session_id,
                workspace_id,
                name.filter(|s| !s.trim().is_empty()),
                prompt,
                cron_expr,
                if recurring { 1 } else { 0 },
                now,
                next,
                backend_id.map(str::trim).filter(|s| !s.is_empty()),
                model.map(str::trim).filter(|s| !s.is_empty()),
            ],
        )?;
        self.get_agent_scheduled_task(&id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn get_agent_scheduled_task(
        &self,
        id: &str,
    ) -> Result<Option<ScheduledTask>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, chat_session_id, workspace_id, kind, name, prompt, reason,
                        fire_at, cron_expr, recurring, enabled, created_at, updated_at,
                        last_fired_at, next_fire_at, failure_count, last_failed_at,
                        last_error, disabled_reason, backend_id, model
                 FROM agent_scheduled_tasks
                 WHERE id = ?1",
                params![id],
                parse_scheduled_task_row,
            )
            .optional()
    }

    pub fn list_agent_scheduled_tasks(&self) -> Result<Vec<ScheduledTask>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, chat_session_id, workspace_id, kind, name, prompt, reason,
                    fire_at, cron_expr, recurring, enabled, created_at, updated_at,
                    last_fired_at, next_fire_at, failure_count, last_failed_at,
                    last_error, disabled_reason, backend_id, model
             FROM agent_scheduled_tasks
             ORDER BY enabled DESC, next_fire_at IS NULL, next_fire_at, created_at",
        )?;
        stmt.query_map([], parse_scheduled_task_row)?.collect()
    }

    pub fn list_agent_scheduled_tasks_for_chat_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<ScheduledTask>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, chat_session_id, workspace_id, kind, name, prompt, reason,
                    fire_at, cron_expr, recurring, enabled, created_at, updated_at,
                    last_fired_at, next_fire_at, failure_count, last_failed_at,
                    last_error, disabled_reason, backend_id, model
             FROM agent_scheduled_tasks
             WHERE chat_session_id = ?1
             ORDER BY enabled DESC, next_fire_at IS NULL, next_fire_at, created_at",
        )?;
        stmt.query_map(params![chat_session_id], parse_scheduled_task_row)?
            .collect()
    }

    pub fn due_agent_scheduled_tasks(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<ScheduledTask>, rusqlite::Error> {
        let now = now.to_rfc3339();
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.chat_session_id, t.workspace_id, t.kind, t.name, t.prompt, t.reason,
                    t.fire_at, t.cron_expr, t.recurring, t.enabled, t.created_at, t.updated_at,
                    t.last_fired_at, t.next_fire_at, t.failure_count, t.last_failed_at,
                    t.last_error, t.disabled_reason, t.backend_id, t.model
             FROM agent_scheduled_tasks t
             JOIN workspaces w ON w.id = t.workspace_id
             WHERE t.enabled = 1
               AND t.next_fire_at IS NOT NULL
               AND t.next_fire_at <= ?1
               AND w.status = 'active'
               AND w.worktree_path IS NOT NULL
               AND TRIM(w.worktree_path) <> ''
             ORDER BY t.next_fire_at, t.created_at",
        )?;
        stmt.query_map(params![now], parse_scheduled_task_row)?
            .collect()
    }

    pub fn next_agent_schedule_fire_at(&self) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT t.next_fire_at
                 FROM agent_scheduled_tasks t
                 JOIN workspaces w ON w.id = t.workspace_id
                 WHERE t.enabled = 1
                   AND t.next_fire_at IS NOT NULL
                   AND w.status = 'active'
                   AND w.worktree_path IS NOT NULL
                   AND TRIM(w.worktree_path) <> ''
                 ORDER BY t.next_fire_at
                 LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn mark_agent_scheduled_task_fired(
        &self,
        task: &ScheduledTask,
        fired_at: DateTime<Utc>,
    ) -> Result<usize, rusqlite::Error> {
        let fired = fired_at.to_rfc3339();
        match task.kind {
            ScheduledTaskKind::Wakeup => self.conn.execute(
                "UPDATE agent_scheduled_tasks
                     SET enabled = 0, last_fired_at = ?2, next_fire_at = NULL, updated_at = ?2
                     WHERE id = ?1
                       AND enabled = 1
                       AND next_fire_at IS NOT NULL
                       AND next_fire_at <= ?2",
                params![task.id, fired],
            ),
            ScheduledTaskKind::Cron => {
                if task.recurring {
                    let next = task
                        .cron_expr
                        .as_deref()
                        .and_then(|expr| next_cron_run_utc(expr, fired_at))
                        .map(|dt| dt.to_rfc3339());
                    self.conn.execute(
                        "UPDATE agent_scheduled_tasks
                         SET last_fired_at = ?2, next_fire_at = ?3, updated_at = ?2
                         WHERE id = ?1
                           AND enabled = 1
                           AND next_fire_at IS NOT NULL
                           AND next_fire_at <= ?2",
                        params![task.id, fired, next],
                    )
                } else {
                    self.conn.execute(
                        "UPDATE agent_scheduled_tasks
                         SET enabled = 0, last_fired_at = ?2, next_fire_at = NULL, updated_at = ?2
                         WHERE id = ?1
                           AND enabled = 1
                           AND next_fire_at IS NOT NULL
                           AND next_fire_at <= ?2",
                        params![task.id, fired],
                    )
                }
            }
        }
    }

    pub fn delete_agent_scheduled_task(&self, id_or_name: &str) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM agent_scheduled_tasks WHERE id = ?1 OR name = ?1",
            params![id_or_name],
        )
    }

    pub fn delete_agent_scheduled_task_for_chat_session(
        &self,
        chat_session_id: &str,
        id_or_name: &str,
    ) -> Result<usize, rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM agent_scheduled_tasks
             WHERE chat_session_id = ?1 AND (id = ?2 OR name = ?2)",
            params![chat_session_id, id_or_name],
        )
    }

    pub fn record_agent_scheduled_task_failure(
        &self,
        id: &str,
        failed_at: DateTime<Utc>,
        error: &str,
    ) -> Result<usize, rusqlite::Error> {
        let failed = failed_at.to_rfc3339();
        self.conn.execute(
            "UPDATE agent_scheduled_tasks
             SET failure_count = failure_count + 1,
                 last_failed_at = ?2,
                 last_error = ?3,
                 updated_at = ?2
             WHERE id = ?1",
            params![id, failed, error],
        )
    }

    pub fn disable_agent_scheduled_task_after_failure(
        &self,
        id: &str,
        failed_at: DateTime<Utc>,
        disabled_reason: &str,
        error: &str,
    ) -> Result<usize, rusqlite::Error> {
        let failed = failed_at.to_rfc3339();
        self.conn.execute(
            "UPDATE agent_scheduled_tasks
             SET enabled = 0,
                 next_fire_at = NULL,
                 failure_count = failure_count + 1,
                 last_failed_at = ?2,
                 last_error = ?4,
                 disabled_reason = ?3,
                 updated_at = ?2
             WHERE id = ?1",
            params![id, failed, disabled_reason, error],
        )
    }

    pub fn disable_due_agent_scheduled_tasks_without_worktrees(
        &self,
        now: DateTime<Utc>,
        disabled_reason: &str,
        error: &str,
    ) -> Result<usize, rusqlite::Error> {
        let now = now.to_rfc3339();
        self.conn.execute(
            "UPDATE agent_scheduled_tasks
             SET enabled = 0,
                 next_fire_at = NULL,
                 failure_count = failure_count + 1,
                 last_failed_at = ?1,
                 last_error = ?3,
                 disabled_reason = ?2,
                 updated_at = ?1
             WHERE enabled = 1
               AND next_fire_at IS NOT NULL
               AND next_fire_at <= ?1
               AND EXISTS (
                   SELECT 1
                   FROM workspaces w
                   WHERE w.id = agent_scheduled_tasks.workspace_id
                     AND (
                         w.status <> 'active'
                         OR w.worktree_path IS NULL
                         OR TRIM(w.worktree_path) = ''
                     )
               )",
            params![now, disabled_reason, error],
        )
    }

    pub fn disable_agent_scheduled_tasks_for_workspace(
        &self,
        workspace_id: &str,
        disabled_at: DateTime<Utc>,
        disabled_reason: &str,
        error: &str,
    ) -> Result<usize, rusqlite::Error> {
        let disabled_at = disabled_at.to_rfc3339();
        self.conn.execute(
            "UPDATE agent_scheduled_tasks
             SET enabled = 0,
                 next_fire_at = NULL,
                 last_failed_at = ?2,
                 last_error = ?4,
                 disabled_reason = ?3,
                 updated_at = ?2
             WHERE workspace_id = ?1
               AND enabled = 1",
            params![workspace_id, disabled_at, disabled_reason, error],
        )
    }

    fn workspace_id_for_chat_session(
        &self,
        chat_session_id: &str,
    ) -> Result<String, rusqlite::Error> {
        self.conn.query_row(
            "SELECT workspace_id FROM chat_sessions WHERE id = ?1",
            params![chat_session_id],
            |row| row.get(0),
        )
    }
}

fn parse_scheduled_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledTask> {
    let kind_raw: String = row.get(3)?;
    let kind = kind_raw.parse().map_err(|e: String| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, e.into())
    })?;
    Ok(ScheduledTask {
        id: row.get(0)?,
        chat_session_id: row.get(1)?,
        workspace_id: row.get(2)?,
        kind,
        name: row.get(4)?,
        prompt: row.get(5)?,
        reason: row.get(6)?,
        fire_at: row.get(7)?,
        cron_expr: row.get(8)?,
        recurring: row.get::<_, i64>(9)? != 0,
        enabled: row.get::<_, i64>(10)? != 0,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        last_fired_at: row.get(13)?,
        next_fire_at: row.get(14)?,
        failure_count: row.get(15)?,
        last_failed_at: row.get(16)?,
        last_error: row.get(17)?,
        disabled_reason: row.get(18)?,
        backend_id: row.get(19)?,
        model: row.get(20)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{make_repo, make_workspace};
    use crate::model::ChatSession;

    #[test]
    fn creates_and_lists_wakeup() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let ws = make_workspace("ws", &repo.id, "work");
        db.insert_workspace(&ws).unwrap();
        let session = db.create_chat_session(&ws.id).unwrap();
        let fire_at = Utc::now() + chrono::Duration::minutes(5);

        let task = db
            .create_agent_wakeup(
                &session.id,
                fire_at,
                "check the build",
                Some("build"),
                None,
                None,
            )
            .unwrap();
        assert_eq!(task.kind, ScheduledTaskKind::Wakeup);
        assert_eq!(task.chat_session_id, session.id);
        assert!(task.enabled);

        let rows = db.list_agent_scheduled_tasks().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].prompt, "check the build");
    }

    #[test]
    fn creates_cron_with_next_fire() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let ws = make_workspace("ws", &repo.id, "work");
        db.insert_workspace(&ws).unwrap();
        let session: ChatSession = db.create_chat_session(&ws.id).unwrap();

        let task = db
            .create_agent_cron_task(
                &session.id,
                Some("hourly"),
                "0 * * * *",
                "check",
                true,
                None,
                None,
            )
            .unwrap();
        assert_eq!(task.kind, ScheduledTaskKind::Cron);
        assert_eq!(task.name.as_deref(), Some("hourly"));
        assert!(task.next_fire_at.is_some());
    }

    #[test]
    fn scoped_list_and_delete_stay_within_chat_session() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let ws = make_workspace("ws", &repo.id, "work");
        db.insert_workspace(&ws).unwrap();
        let session_a = db.create_chat_session(&ws.id).unwrap();
        let session_b = db.create_chat_session(&ws.id).unwrap();

        let task_a = db
            .create_agent_cron_task(
                &session_a.id,
                Some("same-name"),
                "0 * * * *",
                "a",
                true,
                None,
                None,
            )
            .unwrap();
        let task_b = db
            .create_agent_cron_task(&session_b.id, None, "0 * * * *", "b", true, None, None)
            .unwrap();

        let rows = db
            .list_agent_scheduled_tasks_for_chat_session(&session_a.id)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, task_a.id);

        assert_eq!(
            db.delete_agent_scheduled_task_for_chat_session(&session_a.id, &task_b.id)
                .unwrap(),
            0
        );
        assert_eq!(
            db.delete_agent_scheduled_task_for_chat_session(&session_a.id, "same-name")
                .unwrap(),
            1
        );
        assert!(db.get_agent_scheduled_task(&task_b.id).unwrap().is_some());
    }

    #[test]
    fn mark_fired_skips_deleted_or_no_longer_due_rows() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let ws = make_workspace("ws", &repo.id, "work");
        db.insert_workspace(&ws).unwrap();
        let session = db.create_chat_session(&ws.id).unwrap();
        let now = Utc::now();
        let task = db
            .create_agent_wakeup(
                &session.id,
                now - chrono::Duration::minutes(1),
                "check",
                None,
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            db.mark_agent_scheduled_task_fired(&task, now - chrono::Duration::minutes(2))
                .unwrap(),
            0
        );
        db.delete_agent_scheduled_task(&task.id).unwrap();
        assert_eq!(db.mark_agent_scheduled_task_fired(&task, now).unwrap(), 0);
    }

    #[test]
    fn due_tasks_exclude_and_disable_archived_workspace_rows() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let mut ws = make_workspace("ws", &repo.id, "work");
        ws.worktree_path = None;
        ws.status = crate::model::WorkspaceStatus::Archived;
        db.insert_workspace(&ws).unwrap();
        let session = db.create_chat_session(&ws.id).unwrap();
        let now = Utc::now();
        let wakeup = db
            .create_agent_wakeup(
                &session.id,
                now - chrono::Duration::minutes(1),
                "check",
                None,
                None,
                None,
            )
            .unwrap();
        let cron = db
            .create_agent_cron_task(
                &session.id,
                Some("hourly"),
                "0 * * * *",
                "cron",
                true,
                None,
                None,
            )
            .unwrap();
        db.conn
            .execute(
                "UPDATE agent_scheduled_tasks SET next_fire_at = ?2 WHERE id IN (?1, ?3)",
                params![
                    wakeup.id,
                    (now - chrono::Duration::minutes(1)).to_rfc3339(),
                    cron.id
                ],
            )
            .unwrap();

        let disabled = db
            .disable_due_agent_scheduled_tasks_without_worktrees(
                now,
                "workspace_unavailable",
                "Workspace has no worktree",
            )
            .unwrap();
        assert_eq!(disabled, 2);
        assert!(
            db.due_agent_scheduled_tasks(now).unwrap().is_empty(),
            "invalid scheduled tasks must not keep returning as due",
        );
        assert!(
            db.next_agent_schedule_fire_at().unwrap().is_none(),
            "invalid scheduled tasks must not keep the scheduler deadline in the past",
        );

        let rows = db.list_agent_scheduled_tasks().unwrap();
        assert!(rows.iter().all(|task| !task.enabled));
        assert!(rows.iter().all(|task| task.next_fire_at.is_none()));
        assert!(
            rows.iter()
                .all(|task| task.disabled_reason.as_deref() == Some("workspace_unavailable"))
        );
        assert!(rows.iter().all(|task| task.failure_count == 1));
    }

    #[test]
    fn archive_disables_workspace_scheduled_tasks_without_counting_failure() {
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo", "/tmp/repo", "repo");
        db.insert_repository(&repo).unwrap();
        let ws = make_workspace("ws", &repo.id, "work");
        db.insert_workspace(&ws).unwrap();
        let session = db.create_chat_session(&ws.id).unwrap();
        let task = db
            .create_agent_cron_task(
                &session.id,
                Some("daily"),
                "0 9 * * *",
                "check",
                true,
                None,
                None,
            )
            .unwrap();

        assert_eq!(
            db.disable_agent_scheduled_tasks_for_workspace(
                &ws.id,
                Utc::now(),
                "workspace_archived",
                "Workspace was archived",
            )
            .unwrap(),
            1
        );

        let updated = db.get_agent_scheduled_task(&task.id).unwrap().unwrap();
        assert!(!updated.enabled);
        assert!(updated.next_fire_at.is_none());
        assert_eq!(updated.failure_count, 0);
        assert_eq!(
            updated.disabled_reason.as_deref(),
            Some("workspace_archived")
        );
    }
}
