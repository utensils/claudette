CREATE TABLE IF NOT EXISTS interactive_sessions (
    sid                TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    host_kind          TEXT NOT NULL,
    state              TEXT NOT NULL,
    crash_reason       TEXT,
    created_at         TEXT NOT NULL,
    last_attached_at   TEXT,
    last_screen_blob   BLOB,
    claude_flags_json  TEXT NOT NULL,
    pid                INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_workspace
    ON interactive_sessions(workspace_id);
