-- Persisted association between an SCM item (issue / PR) and the
-- workspace created for it via the project-view "Send to new workspace"
-- gesture. Keyed on `workspace_id` — one workspace owns at most one item.
--
-- Distinct from `scm_status_cache` (per-workspace PR badge, keyed on
-- workspace_id) and `repo_scm_lists_cache` (repo-wide issue/PR lists):
-- this table records *which local workspace was spun up for which
-- upstream item*, so the project view can show an "in progress" badge
-- and the workspace can show what it is for.
--
-- `kind` is one of "issue" or "pr". The (repo_id, kind, number) index
-- powers the project-view lookup that decorates each issue / PR row.
--
-- The `workspace_id` FK cascades on hard-delete so a deleted workspace
-- drops its link automatically. Archived workspaces keep their row; the
-- project-view badge filters them out client-side (see issue #898) so
-- an archive -> restore round-trip does not lose the association.
CREATE TABLE IF NOT EXISTS workspace_scm_links (
    workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    repo_id       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
    number        INTEGER NOT NULL,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_scm_links_item
    ON workspace_scm_links (repo_id, kind, number);
