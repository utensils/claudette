CREATE TABLE checkpoint_files (
    id              TEXT PRIMARY KEY,
    checkpoint_id   TEXT NOT NULL REFERENCES conversation_checkpoints(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    content         BLOB,
    file_mode       INTEGER NOT NULL DEFAULT 33188,
    UNIQUE(checkpoint_id, file_path)
);

CREATE INDEX idx_checkpoint_files_checkpoint
    ON checkpoint_files(checkpoint_id);
