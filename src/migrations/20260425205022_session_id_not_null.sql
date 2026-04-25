-- Enforce NOT NULL on chat_messages.session_id and
-- conversation_checkpoints.session_id. The prior migration backfilled
-- all existing rows, and heal_orphaned_sessions() patches stragglers
-- at startup, so NULLs should not exist. Making the constraint
-- explicit prevents future inserts from violating the model contract.
--
-- SQLite cannot ALTER COLUMN to add NOT NULL, so we recreate each table.

-- 1. chat_messages: recreate with session_id NOT NULL
CREATE TABLE chat_messages_new (
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id           TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role                 TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content              TEXT NOT NULL,
    cost_usd             REAL,
    duration_ms          INTEGER,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    thinking             TEXT,
    input_tokens         INTEGER,
    output_tokens        INTEGER,
    cache_read_tokens    INTEGER,
    cache_creation_tokens INTEGER
);

INSERT INTO chat_messages_new
SELECT id, workspace_id, session_id, role, content, cost_usd, duration_ms,
       created_at, thinking, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens
FROM chat_messages
WHERE session_id IS NOT NULL;

DROP TABLE chat_messages;
ALTER TABLE chat_messages_new RENAME TO chat_messages;

CREATE INDEX idx_chat_messages_workspace ON chat_messages(workspace_id, created_at);
CREATE INDEX idx_chat_messages_session   ON chat_messages(session_id, created_at);

-- 2. conversation_checkpoints: recreate with session_id NOT NULL
--    NOTE: has_file_state is NOT a physical column — it is computed at query
--    time via EXISTS(SELECT 1 FROM checkpoint_files ...). commit_hash remains
--    nullable (snapshots may use file state without a git commit).
CREATE TABLE conversation_checkpoints_new (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    message_id      TEXT NOT NULL,
    commit_hash     TEXT,
    turn_index      INTEGER NOT NULL DEFAULT 0,
    message_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO conversation_checkpoints_new
SELECT id, workspace_id, session_id, message_id, commit_hash,
       turn_index, message_count, created_at
FROM conversation_checkpoints
WHERE session_id IS NOT NULL;

DROP TABLE conversation_checkpoints;
ALTER TABLE conversation_checkpoints_new RENAME TO conversation_checkpoints;

CREATE INDEX idx_checkpoints_workspace ON conversation_checkpoints(workspace_id, turn_index);
CREATE INDEX idx_checkpoints_session   ON conversation_checkpoints(session_id, turn_index);
