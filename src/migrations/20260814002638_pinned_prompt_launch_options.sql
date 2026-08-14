-- Pinned-prompt launch options.
--
-- Extends the existing tri-state toolbar overrides with "where and on what
-- does this prompt run":
--
--   new_session    0/1. When 1, clicking the pill opens a fresh chat tab in
--                  the current workspace and runs the prompt there instead of
--                  in the active session.
--   model          Model id to select before the prompt runs (e.g. "opus",
--                  "gpt-5.5"). NULL means "inherit whatever the session
--                  already has".
--   model_provider Backend id that qualifies `model` (e.g. "anthropic",
--                  "codex-native"). Model ids are only unique per backend, so
--                  this pairs with `model` and is NULL whenever `model` is.
--
-- All three are additive and default to the pre-existing behaviour, so rows
-- written before this migration keep working untouched.

ALTER TABLE pinned_prompts ADD COLUMN new_session INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pinned_prompts ADD COLUMN model TEXT;
ALTER TABLE pinned_prompts ADD COLUMN model_provider TEXT;
