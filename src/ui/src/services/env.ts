import { invoke } from "@tauri-apps/api/core";
import type { EnvSourceInfo, EnvTarget } from "../types/env";

/**
 * Fetch the list of env-provider plugins that ran (or were considered)
 * for the target. Cheap after the first call — respects the backend's
 * mtime-keyed cache.
 */
export function getEnvSources(target: EnvTarget): Promise<EnvSourceInfo[]> {
  return invoke("get_env_sources", { target });
}

/**
 * Resolve the worktree path a target maps to. The EnvPanel uses this
 * once per target to filter `env-cache-invalidated` events — a watcher
 * hit for repo B shouldn't make the EnvPanel showing repo A refetch
 * (that would redundantly re-run direnv/nix/mise).
 */
export function getEnvTargetWorktree(target: EnvTarget): Promise<string> {
  return invoke("get_env_target_worktree", { target });
}

/**
 * Evict the env-provider cache for the target. Next spawn or diagnostic
 * query re-runs the affected plugin(s). Pass a `pluginName` to only
 * invalidate one plugin's entry; omit to reload everything.
 *
 * Typical use: after the user runs `direnv allow` / `mise trust` on a
 * worktree that previously errored, they hit "Reload" to pick up the
 * freshly-allowed config without restarting Claudette.
 */
export function reloadEnv(
  target: EnvTarget,
  pluginName?: string,
): Promise<void> {
  return invoke("reload_env", { target, pluginName });
}

/**
 * Enable or disable a specific env-provider plugin for the target's
 * repo. Disabling persists across app restarts. The backend invalidates
 * the plugin's cache entry so the state change takes effect on the
 * next spawn — no need for an explicit reload.
 */
export function setEnvProviderEnabled(
  target: EnvTarget,
  pluginName: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_env_provider_enabled", {
    target,
    pluginName,
    enabled,
  });
}

/**
 * Cheap DB-only read of the per-repo disabled env-provider plugin
 * names. Used by the EnvPanel to hydrate placeholder rows before the
 * initial `getEnvSources` resolve returns, so toggles for repos with
 * already-disabled providers reflect the persisted state immediately
 * rather than briefly showing as enabled.
 */
export function listEnvProviderDisabled(target: EnvTarget): Promise<string[]> {
  return invoke("list_env_provider_disabled", { target });
}

/**
 * Run a plugin's trust command (`direnv allow`, `mise trust`) against
 * the target's worktree. Inherits `HOME`/`PATH` from Claudette so the
 * trust cache update lands in the user's normal location. Invalidates
 * the provider's cache entry on success so the next resolve picks up
 * the freshly-trusted state.
 */
export function runEnvTrust(
  target: EnvTarget,
  pluginName: string,
): Promise<void> {
  return invoke("run_env_trust", { target, pluginName });
}

/** Convenience helper for call sites that have a repo id in hand. */
export function envTargetFromRepo(repoId: string): EnvTarget {
  return { kind: "repo", repo_id: repoId };
}

/** Convenience helper for call sites that have a workspace id in hand. */
export function envTargetFromWorkspace(workspaceId: string): EnvTarget {
  return { kind: "workspace", workspace_id: workspaceId };
}
