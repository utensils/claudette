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
-- `payload` is a JSON-encoded bare array of items (the raw issue or PR
-- list) — never wrapped in an object. The `{ items, unsupported }`
-- envelope is applied later by the Tauri command return shape, not here.
-- See `RepoScmListCacheRow` in `src/db/scm.rs`.
CREATE TABLE IF NOT EXISTS repo_scm_lists_cache (
    repo_id    TEXT NOT NULL,
    list_kind  TEXT NOT NULL,
    provider   TEXT,
    payload    TEXT NOT NULL,
    error      TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo_id, list_kind)
);
