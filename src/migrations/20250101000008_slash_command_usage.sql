CREATE TABLE slash_command_usage (
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    command_name  TEXT NOT NULL,
    use_count     INTEGER NOT NULL DEFAULT 1,
    last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, command_name)
);
