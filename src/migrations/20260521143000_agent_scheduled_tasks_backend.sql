-- Capture which agent backend (and optional model) a scheduled task was
-- created under, so the scheduler dispatches the firing turn to the right
-- runtime instead of resolving to the global default backend.
--
-- Background: `dispatch_prompt_to_session` calls `send_chat_message` with
-- `backend_id: None`, which `resolve_backend_request_defaults` resolves to
-- the `default_agent_backend` app setting (defaults to "anthropic"). So a
-- cron created from a Codex or Pi chat used to fire on Claude instead of
-- the chat's actual backend.
--
-- Both columns are nullable on purpose: rows created before this migration,
-- and agent-callable scheduling that opts not to pin a backend, keep the
-- legacy global-default behavior.

ALTER TABLE agent_scheduled_tasks ADD COLUMN backend_id TEXT;
ALTER TABLE agent_scheduled_tasks ADD COLUMN model TEXT;
