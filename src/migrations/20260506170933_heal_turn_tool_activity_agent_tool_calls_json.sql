-- Heals dev DBs that recorded migration `20260505214219` as applied
-- before commit 2fc1b316 amended that migration to add the
-- `agent_tool_calls_json` column. Because `schema_migrations` is keyed
-- by id, the amended SQL is never re-run, leaving the column missing
-- and breaking `list_completed_turns_for_session` (and therefore the
-- `chat show` / `chat turns` IPC paths). Single statement so the
-- runner's "already exists" leniency tolerates DBs that already have
-- the column from a clean install.
ALTER TABLE turn_tool_activities
    ADD COLUMN agent_tool_calls_json TEXT NOT NULL DEFAULT '[]';
