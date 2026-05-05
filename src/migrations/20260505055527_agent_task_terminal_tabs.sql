ALTER TABLE terminal_tabs ADD COLUMN kind TEXT NOT NULL DEFAULT 'pty';
ALTER TABLE terminal_tabs ADD COLUMN agent_chat_session_id TEXT;
ALTER TABLE terminal_tabs ADD COLUMN agent_tool_use_id TEXT;
ALTER TABLE terminal_tabs ADD COLUMN agent_task_id TEXT;
ALTER TABLE terminal_tabs ADD COLUMN output_path TEXT;
ALTER TABLE terminal_tabs ADD COLUMN task_status TEXT;
ALTER TABLE terminal_tabs ADD COLUMN task_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_terminal_tabs_agent_tool_use
    ON terminal_tabs(agent_tool_use_id);

CREATE INDEX IF NOT EXISTS idx_terminal_tabs_agent_task
    ON terminal_tabs(agent_chat_session_id, agent_task_id);
