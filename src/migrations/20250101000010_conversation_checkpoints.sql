CREATE TABLE conversation_checkpoints (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    message_id    TEXT NOT NULL,
    commit_hash   TEXT,
    turn_index    INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_checkpoints_workspace
    ON conversation_checkpoints(workspace_id, turn_index);
