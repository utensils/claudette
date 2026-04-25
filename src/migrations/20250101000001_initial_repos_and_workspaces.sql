CREATE TABLE repositories (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    branch_name     TEXT NOT NULL,
    worktree_path   TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    status_line     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repository_id, name)
);
