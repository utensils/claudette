ALTER TABLE deleted_workspace_summaries ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deleted_workspace_summaries ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
