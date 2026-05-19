CREATE TABLE deleted_agent_sessions (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT,
    repository_id   TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    ended_at        TEXT,
    turn_count      INTEGER NOT NULL DEFAULT 0,
    completed_ok    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_deleted_agent_sessions_workspace ON deleted_agent_sessions(workspace_id);
CREATE INDEX idx_deleted_agent_sessions_started   ON deleted_agent_sessions(started_at);
CREATE INDEX idx_deleted_agent_sessions_repo      ON deleted_agent_sessions(repository_id);

CREATE TABLE deleted_agent_commits (
    commit_hash     TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    repository_id   TEXT NOT NULL,
    session_id      TEXT,
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    files_changed   INTEGER NOT NULL DEFAULT 0,
    committed_at    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, commit_hash)
);
CREATE INDEX idx_deleted_agent_commits_workspace ON deleted_agent_commits(workspace_id);
CREATE INDEX idx_deleted_agent_commits_committed ON deleted_agent_commits(committed_at);
CREATE INDEX idx_deleted_agent_commits_repo      ON deleted_agent_commits(repository_id);

CREATE TABLE deleted_slash_command_usage (
    workspace_id  TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    command_name  TEXT NOT NULL,
    use_count     INTEGER NOT NULL DEFAULT 1,
    last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, command_name)
);
CREATE INDEX idx_deleted_slash_command_usage_repo ON deleted_slash_command_usage(repository_id);
