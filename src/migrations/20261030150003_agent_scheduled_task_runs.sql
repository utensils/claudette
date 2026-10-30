-- Per-fire history for scheduled tasks, so the Loops and Schedules view can
-- show recent runs and jump to the session a fire landed in. New-session
-- tasks create a different session every fire, so `last_fired_at` alone
-- can't answer "where did the last run go?".
--
-- `chat_session_id` has no foreign key on purpose: the session may be
-- archived later, but the run record should keep pointing at it. Runs are
-- deleted with their task.

CREATE TABLE IF NOT EXISTS agent_scheduled_task_runs (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES agent_scheduled_tasks(id) ON DELETE CASCADE,
    chat_session_id TEXT,
    source          TEXT NOT NULL,
    fired_at        TEXT NOT NULL,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_task_runs_task
    ON agent_scheduled_task_runs(task_id, fired_at);

CREATE INDEX IF NOT EXISTS idx_agent_scheduled_task_runs_fired
    ON agent_scheduled_task_runs(fired_at);
