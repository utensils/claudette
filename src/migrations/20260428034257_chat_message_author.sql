-- Add author identity to chat messages so collaborative sessions can render
-- which connected user prompted the agent. In a collab session, the host
-- stamps `"host"` on its own messages and the per-pairing id on
-- remote-authored ones; outside a collab session (solo, 1:1, all
-- pre-collab history) both columns are NULL and the UI treats the
-- message as authored by the local user (no author chip).

ALTER TABLE chat_messages
    ADD COLUMN author_participant_id TEXT;

ALTER TABLE chat_messages
    ADD COLUMN author_display_name TEXT;
