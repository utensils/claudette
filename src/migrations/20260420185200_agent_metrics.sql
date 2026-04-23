CREATE TABLE agent_sessions (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id   TEXT NOT NULL,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    turn_count      INTEGER NOT NULL DEFAULT 0,
    completed_ok    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id);
CREATE INDEX idx_agent_sessions_started   ON agent_sessions(started_at);

CREATE TABLE agent_commits (
    commit_hash     TEXT NOT NULL,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    repository_id   TEXT NOT NULL,
    session_id      TEXT,
    additions       INTEGER NOT NULL DEFAULT 0,
    deletions       INTEGER NOT NULL DEFAULT 0,
    files_changed   INTEGER NOT NULL DEFAULT 0,
    committed_at    TEXT NOT NULL,
    PRIMARY KEY (workspace_id, commit_hash)
);
CREATE INDEX idx_agent_commits_workspace ON agent_commits(workspace_id);
CREATE INDEX idx_agent_commits_committed ON agent_commits(committed_at);

CREATE TABLE deleted_workspace_summaries (
    id                        TEXT PRIMARY KEY,
    workspace_id              TEXT NOT NULL,
    workspace_name            TEXT NOT NULL,
    repository_id             TEXT NOT NULL,
    workspace_created_at      TEXT NOT NULL,
    deleted_at                TEXT NOT NULL DEFAULT (datetime('now')),
    sessions_started          INTEGER NOT NULL DEFAULT 0,
    sessions_completed        INTEGER NOT NULL DEFAULT 0,
    total_turns               INTEGER NOT NULL DEFAULT 0,
    total_session_duration_ms INTEGER NOT NULL DEFAULT 0,
    commits_made              INTEGER NOT NULL DEFAULT 0,
    total_additions           INTEGER NOT NULL DEFAULT 0,
    total_deletions           INTEGER NOT NULL DEFAULT 0,
    total_files_changed       INTEGER NOT NULL DEFAULT 0,
    messages_user             INTEGER NOT NULL DEFAULT 0,
    messages_assistant        INTEGER NOT NULL DEFAULT 0,
    messages_system           INTEGER NOT NULL DEFAULT 0,
    total_cost_usd            REAL NOT NULL DEFAULT 0,
    first_message_at          TEXT,
    last_message_at           TEXT,
    slash_commands_used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_deleted_ws_summaries_repo ON deleted_workspace_summaries(repository_id);
