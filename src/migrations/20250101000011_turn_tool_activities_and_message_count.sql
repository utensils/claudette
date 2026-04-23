CREATE TABLE turn_tool_activities (
    id              TEXT PRIMARY KEY,
    checkpoint_id   TEXT NOT NULL REFERENCES conversation_checkpoints(id) ON DELETE CASCADE,
    tool_use_id     TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    input_json      TEXT NOT NULL DEFAULT '',
    result_text     TEXT NOT NULL DEFAULT '',
    summary         TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_turn_tool_activities_checkpoint
    ON turn_tool_activities(checkpoint_id, sort_order);

ALTER TABLE conversation_checkpoints ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
