-- Per-repository ordering for workspaces in the sidebar. Mirrors the column
-- added for repositories in 20250101000012. Scoped per repository_id (not
-- globally) because workspaces live inside their repo's worktree on disk;
-- a workspace's natural sort context is its sibling workspaces under the
-- same repo.
ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Seed initial values from creation order so existing workspaces keep their
-- current display order until the user drags them. Index is per-repo so
-- ties between unrelated workspaces don't matter.
UPDATE workspaces SET sort_order = (
    SELECT COUNT(*)
    FROM workspaces w2
    WHERE w2.repository_id = workspaces.repository_id
      AND (
        w2.created_at < workspaces.created_at
        OR (w2.created_at = workspaces.created_at AND w2.id < workspaces.id)
      )
);

CREATE INDEX IF NOT EXISTS idx_workspaces_sort
    ON workspaces(repository_id, sort_order);
