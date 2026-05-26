-- Content-addressed blob storage for checkpoint snapshots.
--
-- Closes #940 / #942: before this migration every checkpoint stored a fresh
-- copy of every file's bytes (no dedup, no compression), bloating
-- `checkpoint_files` to tens of GB on active repos where 99%+ of the stored
-- data was duplicate. After this migration each unique blob lives once in
-- `checkpoint_blobs` keyed by its sha256, and `checkpoint_files` rows hold
-- a sha reference instead of raw bytes.
--
-- The hash is computed over **raw uncompressed bytes** so dedupe survives a
-- future switch to zstd-compressed storage (`compression` column is reserved
-- for that follow-up).
--
-- Legacy rows keep their `content` column populated; the read path falls
-- back to `content` when `blob_sha256` is NULL. A startup backfill task
-- migrates legacy rows over time without blocking app launch.

CREATE TABLE checkpoint_blobs (
    sha256      TEXT PRIMARY KEY,
    bytes       BLOB NOT NULL,
    byte_size   INTEGER NOT NULL,
    compression TEXT NOT NULL DEFAULT 'none',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nullable on purpose: legacy rows still reference `content`; new rows
-- (and backfilled rows) reference `blob_sha256` instead. The read path
-- prefers the blob reference and falls back to `content` for un-backfilled
-- rows.
ALTER TABLE checkpoint_files ADD COLUMN blob_sha256 TEXT
    REFERENCES checkpoint_blobs(sha256);

CREATE INDEX idx_checkpoint_files_blob_sha256
    ON checkpoint_files(blob_sha256);

-- Retention pruning queries `conversation_checkpoints` by workspace ordered
-- by created_at; without this index that path table-scans the entire
-- workspace's checkpoint history on every snapshot.
CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace_created_at
    ON conversation_checkpoints(workspace_id, created_at);
