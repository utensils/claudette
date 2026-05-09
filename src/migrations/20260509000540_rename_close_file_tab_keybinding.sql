-- The `file-viewer.close-file-tab` action was promoted to a global,
-- context-aware `global.close-tab` that handles file / diff / chat
-- equally. Persisted user overrides live in `app_settings` keyed by
-- `keybinding:<actionId>`; without this migration any user who
-- customized the prior binding would silently get the default on the
-- new id and have an orphaned row pointing at the deleted id.
--
-- Mirrors the prior keybinding-rename pattern at
-- `20260508181215_rename_cycle_workspace_keybindings.sql`. The
-- `INSERT OR IGNORE` form preserves an explicit override under the
-- new id if one already exists (e.g. a user who set both names across
-- versions); the subsequent `DELETE` then removes the orphan legacy
-- row whether or not we copied from it.
INSERT OR IGNORE INTO app_settings (key, value)
SELECT 'keybinding:global.close-tab', value
FROM app_settings
WHERE key = 'keybinding:file-viewer.close-file-tab';

DELETE FROM app_settings
WHERE key = 'keybinding:file-viewer.close-file-tab';
