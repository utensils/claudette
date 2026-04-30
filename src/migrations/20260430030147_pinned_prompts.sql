-- Generalize pinned commands into pinned prompts.
--
-- Adds support for: arbitrary prompt bodies (not only slash commands),
-- user-chosen display names, an "auto send" flag, and a global scope
-- (repo_id IS NULL) in addition to the existing per-repo scope.

CREATE TABLE pinned_prompts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id      TEXT REFERENCES repositories(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    auto_send    INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Display names are unique within their scope. SQLite treats NULLs as distinct
-- in plain UNIQUE indices, so we use two partial indices to express
-- "unique per repo" and "unique among globals".
CREATE UNIQUE INDEX idx_pinned_prompts_repo_name
    ON pinned_prompts(repo_id, display_name) WHERE repo_id IS NOT NULL;
CREATE UNIQUE INDEX idx_pinned_prompts_global_name
    ON pinned_prompts(display_name) WHERE repo_id IS NULL;

CREATE INDEX idx_pinned_prompts_order
    ON pinned_prompts(repo_id, sort_order);

-- Forward-migrate existing pinned_commands rows. The old command_name becomes
-- both the display label and the slash-command body; auto_send defaults to 0
-- to preserve legacy "insert into composer" behavior.
INSERT INTO pinned_prompts (repo_id, display_name, prompt, auto_send, sort_order, created_at)
SELECT repo_id, command_name, '/' || command_name, 0, sort_order, created_at
FROM pinned_commands;

DROP TABLE pinned_commands;
