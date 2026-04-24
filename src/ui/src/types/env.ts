/**
 * Matches `EnvSourceInfo` serialized by the Rust `get_workspace_env_sources`
 * Tauri command. One entry per env-provider plugin that was considered for
 * the workspace (detected or not).
 */
export interface EnvSourceInfo {
  /** Internal plugin id, e.g. `env-direnv`. Used for API calls. */
  plugin_name: string;
  /** Human-friendly name from the manifest, e.g. `direnv`. Used in the UI. */
  display_name: string;
  /** Whether the plugin declared it applies to this workspace. */
  detected: boolean;
  /** Whether the user has this provider enabled for the workspace's repo. */
  enabled: boolean;
  /** How many env vars this plugin contributed to the merged result. */
  vars_contributed: number;
  /** `true` when this plugin's contribution came from the mtime cache. */
  cached: boolean;
  /** Milliseconds since Unix epoch — format via `new Date(...).toLocaleString()`. */
  evaluated_at_ms: number;
  /** Set when detect or export errored (e.g. "direnv not allowed"). */
  error: string | null;
}
