ALTER TABLE chat_messages ADD COLUMN input_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN output_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN cache_creation_tokens INTEGER;
