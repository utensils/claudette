CREATE TABLE pinned_commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    command_name TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo_id, command_name)
);

CREATE INDEX idx_pinned_commands_repo
    ON pinned_commands(repo_id, sort_order);
