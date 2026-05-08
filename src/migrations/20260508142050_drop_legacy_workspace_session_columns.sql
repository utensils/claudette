-- Drop dead workspace-scoped Claude CLI session columns.
--
-- Background: 20250101000009_workspace_session_and_turn_count.sql added
-- `workspaces.session_id` and `workspaces.turn_count` so a workspace could
-- remember its Claude CLI session id across app restarts. The multi-session
-- refactor (20260422000000_chat_sessions.sql) moved that responsibility to
-- `chat_sessions.session_id` / `chat_sessions.turn_count` and backfilled
-- existing rows; live agent code (commands/chat/send.rs etc.) has only
-- written the per-session columns since then.
--
-- The workspace-scoped columns were left behind. Their only remaining
-- consumer was `fork::copy_claude_session`, which read `workspaces.session_id`
-- and consequently always saw NULL post-multi-session — turning every fork
-- into a fresh Claude session that lost the parent's conversational context.
-- The fork code now reads/writes via `chat_sessions`, so the columns are dead.
ALTER TABLE workspaces DROP COLUMN session_id;
ALTER TABLE workspaces DROP COLUMN turn_count;
