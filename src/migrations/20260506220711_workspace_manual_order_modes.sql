-- Preserve manual workspace ordering created by versions that had
-- workspaces.sort_order but no explicit "manual ordering" marker.
--
-- The original workspace_sort_order migration seeded sort_order from
-- per-repo creation order. If a repo now differs from that seed, the user
-- manually reordered it before this marker existed. Backfill the marker once
-- so startup keeps honoring the user's existing order. Repos still matching
-- creation order remain automatic by default.
INSERT OR IGNORE INTO app_settings (key, value)
SELECT 'workspace_order_mode:' || repository_id, 'manual'
FROM (
    SELECT
        id,
        repository_id,
        sort_order,
        ROW_NUMBER() OVER (
            PARTITION BY repository_id
            ORDER BY created_at, id
        ) - 1 AS creation_order
    FROM workspaces
)
WHERE sort_order <> creation_order
GROUP BY repository_id;
