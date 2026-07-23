-- Stores the phase/agent tree that Claude Code's `Workflow` tool reports
-- on `subtype: "task_progress"` stream events, so a completed run stays
-- readable after a reload and in DB-replayed history (see
-- `reconstructTurns.ts`). Mirrors the `agent_tool_calls_json` column:
-- opaque JSON to SQLite, parsed on the way out.
--
-- Single statement so the runner's "already exists" leniency applies
-- cleanly if the column is ever hand-applied on a dev DB.
ALTER TABLE turn_tool_activities
    ADD COLUMN workflow_progress_json TEXT NOT NULL DEFAULT '[]';
