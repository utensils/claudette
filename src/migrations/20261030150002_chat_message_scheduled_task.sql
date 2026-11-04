-- Mark chat messages that a scheduled task injected, so the chat surface can
-- render a "Scheduled" affordance on the triggering user prompt.
--
-- Nullable, no foreign key: the referenced task may be deleted later, but the
-- message should keep its provenance marker. NULL for every normal prompt.
ALTER TABLE chat_messages ADD COLUMN scheduled_task_id TEXT;
