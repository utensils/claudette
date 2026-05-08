-- The `global.cycle-workspace-prev/next` hotkey actions were renamed
-- to `global.cycle-tab-prev/next` when the unified workspace tab strip
-- subsumed enough per-workspace surfaces that tab-cycle became the
-- higher-frequency intent. Persisted user overrides live in
-- `app_settings` keyed by `keybinding:<actionId>`; without this
-- migration any user who customized the prior binding would silently
-- get the default on the new id and have an orphaned row pointing at
-- the deleted id.
--
-- The `INSERT OR IGNORE` form preserves an explicit override under
-- the new id if one already exists (e.g. a user who set both names
-- across versions); the subsequent `DELETE` then removes the orphan
-- legacy row whether or not we copied from it.
INSERT OR IGNORE INTO app_settings (key, value)
SELECT 'keybinding:global.cycle-tab-prev', value
FROM app_settings
WHERE key = 'keybinding:global.cycle-workspace-prev';

INSERT OR IGNORE INTO app_settings (key, value)
SELECT 'keybinding:global.cycle-tab-next', value
FROM app_settings
WHERE key = 'keybinding:global.cycle-workspace-next';

DELETE FROM app_settings
WHERE key IN (
    'keybinding:global.cycle-workspace-prev',
    'keybinding:global.cycle-workspace-next'
);
