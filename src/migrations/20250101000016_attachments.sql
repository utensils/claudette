CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    data         BLOB NOT NULL,
    width        INTEGER,
    height       INTEGER,
    size_bytes   INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attachments_message
    ON attachments(message_id);
