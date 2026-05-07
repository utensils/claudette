-- Stores the redacted, shell-quoted `claude` CLI invocation captured at
-- session start. NULL for sessions created before this column existed —
-- the chat-tab banner renders nothing in that case (graceful absence).
ALTER TABLE chat_sessions ADD COLUMN cli_invocation TEXT;
