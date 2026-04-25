CREATE TABLE remote_connections (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    host                TEXT NOT NULL,
    port                INTEGER DEFAULT 7683,
    session_token       TEXT,
    cert_fingerprint    TEXT,
    auto_connect        INTEGER DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
