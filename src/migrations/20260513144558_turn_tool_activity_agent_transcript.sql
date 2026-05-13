ALTER TABLE turn_tool_activities ADD COLUMN agent_thinking_blocks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE turn_tool_activities ADD COLUMN agent_result_text TEXT;
