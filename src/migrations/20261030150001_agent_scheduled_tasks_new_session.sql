-- Support scheduled tasks that create a FRESH chat session in their target
-- workspace at fire time, instead of always reusing one existing session.
--
-- Two changes:
--   1. `chat_session_id` becomes NULLABLE. A `create_new_session` task has no
--      session at schedule time — the scheduler makes one in `workspace_id`
--      each time it fires (so a recurring cron gets a clean session per run).
--   2. New `create_new_session` flag (0 = reuse `chat_session_id`, the legacy
--      behavior; 1 = create a new session in `workspace_id` on each fire).
--
-- SQLite cannot drop a NOT NULL constraint in place, so we rebuild the table.
-- Nothing references `agent_scheduled_tasks` (it only points OUT at
-- chat_sessions / workspaces), so the create-copy-drop-rename is safe with
-- foreign_keys=ON: copied rows preserve valid references and no child table
-- is orphaned. All existing rows are reuse-mode (create_new_session = 0).

CREATE TABLE agent_scheduled_tasks_new (
    id                 TEXT PRIMARY KEY,
    chat_session_id    TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    create_new_session INTEGER NOT NULL DEFAULT 0,
    kind               TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
    name               TEXT,
    prompt             TEXT NOT NULL,
    reason             TEXT,
    fire_at            TEXT,
    cron_expr          TEXT,
    recurring          INTEGER NOT NULL DEFAULT 0,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired_at      TEXT,
    next_fire_at       TEXT,
    backend_id         TEXT,
    model              TEXT,
    failure_count      INTEGER NOT NULL DEFAULT 0,
    last_failed_at     TEXT,
    last_error         TEXT,
    disabled_reason    TEXT
);

INSERT INTO agent_scheduled_tasks_new (
    id, chat_session_id, workspace_id, create_new_session, kind, name, prompt, reason,
    fire_at, cron_expr, recurring, enabled, created_at, updated_at, last_fired_at,
    next_fire_at, backend_id, model, failure_count, last_failed_at, last_error, disabled_reason
)
SELECT
    id, chat_session_id, workspace_id, 0, kind, name, prompt, reason,
    fire_at, cron_expr, recurring, enabled, created_at, updated_at, last_fired_at,
    next_fire_at, backend_id, model, failure_count, last_failed_at, last_error, disabled_reason
FROM agent_scheduled_tasks;

DROP TABLE agent_scheduled_tasks;

ALTER TABLE agent_scheduled_tasks_new RENAME TO agent_scheduled_tasks;

CREATE INDEX idx_agent_scheduled_tasks_next_fire
    ON agent_scheduled_tasks(enabled, next_fire_at);

CREATE INDEX idx_agent_scheduled_tasks_session
    ON agent_scheduled_tasks(chat_session_id, kind);

CREATE UNIQUE INDEX idx_agent_scheduled_tasks_name
    ON agent_scheduled_tasks(name)
    WHERE name IS NOT NULL;
