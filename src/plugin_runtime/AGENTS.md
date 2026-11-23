# Plugin system

One sandboxed Lua runtime (mlua) serves every plugin kind. The kind comes from the `kind` field in `plugin.json` (`scm` | `env-provider`, defaulting to `scm`). Each kind has a domain consumer that dispatches operations on top of this runtime: `src/scm/` and `src/env_provider/`.

## Where plugins come from

- **Bundled** plugins live in `plugins/*/`. They're compiled in with `include_str!` and seeded into the user's plugin dir on first run (`seed.rs`).
- **User** plugins live in `~/.claudette/plugins/<name>/` (`plugin.json` + `init.lua`) and are discovered at startup.

## Contracts

- **Manifest fields and `host.*` functions are public API.** User plugins you can't see depend on them. Add to them; don't rename or reinterpret them.
- **Widening the sandbox** (new `host.*` functions in `host_api.rs`, new capabilities, filesystem, process or network access) must go through the granted-capabilities flow. Add a case to `tests/grants_enforcement.rs`.
- **Plugin settings** (`manifest.settings: Vec<PluginSettingField>`; boolean, text or select):
  - User values persist in `app_settings` as `plugin:{name}:setting:{key}`.
  - Lua reads them through `host.config("<key>")`.
  - Manifest defaults apply when the user hasn't set a value.
- **On/off state** persists as `plugin:{name}:enabled = "false"`. An absent key means enabled.

## Settings UI

Two separate concepts, both always shown in the Settings nav:

- **Plugins** (`src/ui/src/components/settings/sections/PluginsSettings.tsx`) are these Lua plugins: status, the on/off toggle, and the settings form.
- **Claude Code Plugins** (`ClaudeCodePluginsSettings.tsx`, route `claude-code-plugins`) are the Claude CLI marketplace integration in `src/plugin.rs`.
