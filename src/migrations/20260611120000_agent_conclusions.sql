-- Persisted "conclusion of the work" cards presented by the agent via the
-- `present_conclusion` MCP tool. Kept in their own table (rather than as a new
-- chat_messages kind) so the widely-constructed ChatMessage struct stays
-- unchanged. Anchored to the user message that triggered the turn (nullable)
-- so the FK cascade removes the conclusion when that turn is rolled back.
CREATE TABLE IF NOT EXISTS agent_conclusions (
    id              TEXT PRIMARY KEY,
    chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    message_id      TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
    title           TEXT,
    summary         TEXT NOT NULL,
    artifacts_json  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_conclusions_session
    ON agent_conclusions(chat_session_id, created_at);
