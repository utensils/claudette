-- Repo-wide SCM list cache: open issues and open PRs (by scope) for the
-- project-view aggregation. Separate from `scm_status_cache`, which keys on
-- workspace_id and serves the per-workspace PR badge.
--
-- `list_kind` is one of:
--   "issues"
--   "pull_requests:open"
--   "pull_requests:mine"
--   "pull_requests:review_requested"
--
-- `payload` is JSON: { items: [...], unsupported?: bool }
CREATE TABLE IF NOT EXISTS repo_scm_lists_cache (
    repo_id    TEXT NOT NULL,
    list_kind  TEXT NOT NULL,
    provider   TEXT,
    payload    TEXT NOT NULL,
    error      TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo_id, list_kind)
);
