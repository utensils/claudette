ALTER TABLE turn_tool_activities
    ADD COLUMN assistant_message_ordinal INTEGER NOT NULL DEFAULT -1;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_task_id TEXT;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_description TEXT;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_last_tool_name TEXT;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_tool_use_count INTEGER;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_status TEXT;
