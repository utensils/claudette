ALTER TABLE agent_scheduled_tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_scheduled_tasks ADD COLUMN last_failed_at TEXT;
ALTER TABLE agent_scheduled_tasks ADD COLUMN last_error TEXT;
ALTER TABLE agent_scheduled_tasks ADD COLUMN disabled_reason TEXT;
