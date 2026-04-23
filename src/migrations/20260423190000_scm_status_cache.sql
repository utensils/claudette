CREATE TABLE scm_status_cache (
    workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_id       TEXT NOT NULL,
    branch_name   TEXT NOT NULL,
    provider      TEXT,
    pr_json       TEXT,
    ci_json       TEXT,
    error         TEXT,
    fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
