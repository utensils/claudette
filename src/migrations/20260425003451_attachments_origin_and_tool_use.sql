-- Distinguish user-supplied attachments from agent-authored ones, and link
-- agent attachments to the MCP tool call that produced them.
--
-- `origin` defaults to 'user' so existing rows (all user-supplied) retain
-- correct semantics without backfill. `tool_use_id` is nullable because v1
-- defers FIFO pairing — agent rows are stored with NULL until/unless the
-- pairing logic is added later.

ALTER TABLE attachments
    ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'agent'));

ALTER TABLE attachments
    ADD COLUMN tool_use_id TEXT;

CREATE INDEX idx_attachments_tool_use
    ON attachments(tool_use_id)
    WHERE tool_use_id IS NOT NULL;
