import { invoke } from "@tauri-apps/api/core";
import type { EnvSourceInfo } from "../types/env";

/**
 * Fetch the list of env-provider plugins that ran (or were considered)
 * for a workspace. Cheap after the first call — respects the backend's
 * mtime-keyed cache.
 */
export function getWorkspaceEnvSources(
  workspaceId: string,
): Promise<EnvSourceInfo[]> {
  return invoke("get_workspace_env_sources", { workspaceId });
}

/**
 * Evict the env-provider cache for a workspace. Next spawn or diagnostic
 * query re-runs the affected plugin(s). Pass a `pluginName` to only
 * invalidate one plugin's entry; omit to reload everything.
 *
 * Typical use: after the user runs `direnv allow` / `mise trust` on a
 * worktree that previously errored, they hit "Reload" to pick up the
 * freshly-allowed config without restarting Claudette.
 */
export function reloadWorkspaceEnv(
  workspaceId: string,
  pluginName?: string,
): Promise<void> {
  return invoke("reload_workspace_env", { workspaceId, pluginName });
}

/**
 * Enable or disable a specific env-provider plugin for the workspace's
 * repo. Disabling persists across app restarts. The backend invalidates
 * the plugin's cache entry so the state change takes effect on the
 * next spawn — no need for an explicit reload.
 */
export function setEnvProviderEnabled(
  workspaceId: string,
  pluginName: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_env_provider_enabled", {
    workspaceId,
    pluginName,
    enabled,
  });
}
