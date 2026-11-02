-- Subagent usage reported on Claude Code `task_progress` /
-- `task_notification` events (`usage.total_tokens`, `usage.duration_ms`).
-- Nullable: absent for non-Agent tools and for rows saved before the
-- client started recording them.
ALTER TABLE turn_tool_activities
    ADD COLUMN agent_total_tokens INTEGER;

ALTER TABLE turn_tool_activities
    ADD COLUMN agent_duration_ms INTEGER;
