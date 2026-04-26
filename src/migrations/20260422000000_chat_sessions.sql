CREATE TABLE chat_sessions (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id   TEXT,
    name         TEXT NOT NULL DEFAULT 'New chat',
    name_edited  INTEGER NOT NULL DEFAULT 0,
    turn_count   INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at  TEXT
);

CREATE INDEX idx_chat_sessions_ws
    ON chat_sessions(workspace_id, sort_order);
CREATE INDEX idx_chat_sessions_active
    ON chat_sessions(workspace_id, status);

ALTER TABLE chat_messages ADD COLUMN chat_session_id TEXT
    REFERENCES chat_sessions(id) ON DELETE CASCADE;
ALTER TABLE conversation_checkpoints ADD COLUMN chat_session_id TEXT
    REFERENCES chat_sessions(id) ON DELETE CASCADE;

CREATE INDEX idx_chat_messages_chat_session
    ON chat_messages(chat_session_id, created_at);
CREATE INDEX idx_checkpoints_chat_session
    ON conversation_checkpoints(chat_session_id, turn_index);

-- Backfill: create one "Main" session per workspace, carrying over the
-- workspace's current Claude CLI session UUID and turn count.
INSERT INTO chat_sessions (id, workspace_id, session_id, name, name_edited,
                           turn_count, sort_order, status)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-a' ||
    substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    id, session_id, 'Main', 0, turn_count, 0, 'active'
FROM workspaces;

-- Point existing messages at their workspace's new chat session.
UPDATE chat_messages SET chat_session_id = (
    SELECT cs.id FROM chat_sessions cs
    WHERE cs.workspace_id = chat_messages.workspace_id
) WHERE chat_session_id IS NULL;

-- Point existing checkpoints at their workspace's new chat session.
UPDATE conversation_checkpoints SET chat_session_id = (
    SELECT cs.id FROM chat_sessions cs
    WHERE cs.workspace_id = conversation_checkpoints.workspace_id
) WHERE chat_session_id IS NULL;
