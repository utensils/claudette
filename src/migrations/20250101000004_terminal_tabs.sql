CREATE TABLE terminal_tabs (
    id               INTEGER PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title            TEXT NOT NULL DEFAULT 'Terminal',
    is_script_output INTEGER NOT NULL DEFAULT 0,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_terminal_tabs_workspace
    ON terminal_tabs(workspace_id, sort_order);
