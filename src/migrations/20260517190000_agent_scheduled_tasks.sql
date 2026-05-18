CREATE TABLE agent_scheduled_tasks (
    id              TEXT PRIMARY KEY,
    chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
    name            TEXT,
    prompt          TEXT NOT NULL,
    reason          TEXT,
    fire_at         TEXT,
    cron_expr       TEXT,
    recurring       INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired_at   TEXT,
    next_fire_at    TEXT
);

CREATE INDEX idx_agent_scheduled_tasks_next_fire
    ON agent_scheduled_tasks(enabled, next_fire_at);

CREATE INDEX idx_agent_scheduled_tasks_session
    ON agent_scheduled_tasks(chat_session_id, kind);

CREATE UNIQUE INDEX idx_agent_scheduled_tasks_name
    ON agent_scheduled_tasks(name)
    WHERE name IS NOT NULL;
