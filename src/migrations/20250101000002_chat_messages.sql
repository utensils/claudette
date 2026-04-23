CREATE TABLE chat_messages (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content       TEXT NOT NULL,
    cost_usd      REAL,
    duration_ms   INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_workspace
    ON chat_messages(workspace_id, created_at);
