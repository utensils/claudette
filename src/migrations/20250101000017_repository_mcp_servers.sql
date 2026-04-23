CREATE TABLE IF NOT EXISTS repository_mcp_servers (
    id              TEXT PRIMARY KEY,
    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    config_json     TEXT NOT NULL,
    source          TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repository_id, name)
);
