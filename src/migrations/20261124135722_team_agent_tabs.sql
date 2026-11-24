CREATE TABLE IF NOT EXISTS team_agent_tabs (
    parent_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    tool_use_id TEXT NOT NULL,
    linked_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
    PRIMARY KEY (parent_session_id, tool_use_id)
);
