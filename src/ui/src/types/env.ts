/**
 * What to resolve env-provider state for. Mirrors the Rust `EnvTarget`
 * enum with `#[serde(tag = "kind", rename_all = "snake_case")]`.
 *
 * Use `{ kind: "repo", repo_id }` in Repo Settings so the panel works
 * before a workspace exists. Use `{ kind: "workspace", workspace_id }`
 * from a workspace-scoped view.
 */
export type EnvTarget =
  | { kind: "repo"; repo_id: string }
  | { kind: "workspace"; workspace_id: string };

/**
 * Matches `EnvSourceInfo` serialized by the Rust `get_env_sources`
 * Tauri command. One entry per env-provider plugin that was considered
 * for the target (detected or not).
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
  /**
   * True when the plugin's required CLI (e.g. `nix`, `mise`, `direnv`)
   * is not on PATH. Distinct from `enabled` (user intent) and `error`
   * (runtime failure): the system can't run this provider until the
   * tool is installed. The toggle is locked off in this state. See
   * GitHub issue 718.
   */
  unavailable: boolean;
  /** How many env vars this plugin contributed to the merged result. */
  vars_contributed: number;
  /** `true` when this plugin's contribution came from the mtime cache. */
  cached: boolean;
  /** Milliseconds since Unix epoch — format via `new Date(...).toLocaleString()`. */
  evaluated_at_ms: number;
  /** Set when detect or export errored (e.g. "direnv not allowed"). */
  error: string | null;
}
