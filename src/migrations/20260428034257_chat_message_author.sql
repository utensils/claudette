-- Add author identity to chat messages so collaborative sessions can render
-- which connected user prompted the agent. Both columns are NULL for the
-- host's own messages and for all historical (pre-collab) rows; UI treats
-- NULL as "the local user" and skips the author chip.

ALTER TABLE chat_messages
    ADD COLUMN author_participant_id TEXT;

ALTER TABLE chat_messages
    ADD COLUMN author_display_name TEXT;
