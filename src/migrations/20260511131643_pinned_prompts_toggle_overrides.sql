-- Pinned-prompt tri-state toggle overrides.
--
-- Each column is nullable: NULL means "inherit the session's current toolbar
-- value" when the prompt is used; 0/1 forces the toolbar toggle off/on (and
-- the write is sticky — see ChatInputArea.handleUsePinnedPrompt).

ALTER TABLE pinned_prompts ADD COLUMN plan_mode INTEGER;
ALTER TABLE pinned_prompts ADD COLUMN fast_mode INTEGER;
ALTER TABLE pinned_prompts ADD COLUMN thinking_enabled INTEGER;
ALTER TABLE pinned_prompts ADD COLUMN chrome_enabled INTEGER;
