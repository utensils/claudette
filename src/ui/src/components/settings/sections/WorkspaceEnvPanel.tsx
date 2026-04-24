import { useCallback, useEffect, useState } from "react";
import {
  getWorkspaceEnvSources,
  reloadWorkspaceEnv,
  setEnvProviderEnabled,
} from "../../../services/env";
import type { EnvSourceInfo } from "../../../types/env";
import styles from "../Settings.module.css";

interface WorkspaceEnvPanelProps {
  workspaceId: string;
}

/**
 * Per-provider status color. Matches the MCP server row palette so the
 * Environment section reads with the same visual grammar:
 *
 *   green  — active + fresh eval
 *   blue   — active + cache hit (same semantic as MCP "connected")
 *   red    — error (direnv blocked, mise untrusted, flake eval failed)
 *   dim    — not detected (plugin's detect() returned false) OR disabled
 */
function stateColor(source: EnvSourceInfo): string {
  if (!source.enabled) return "var(--text-faint)";
  if (source.error) return "var(--status-stopped)";
  if (!source.detected) return "var(--text-faint)";
  return source.cached ? "var(--status-idle)" : "var(--status-running)";
}

function stateBadge(source: EnvSourceInfo): string {
  if (!source.enabled) return "disabled";
  if (source.error) return "error";
  if (!source.detected) return "not detected";
  return source.cached ? "cached" : "fresh";
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Environment providers panel for a workspace.
 *
 * Mirrors the MCP servers list pattern (mcpRow/mcpInfo/mcpActions + toggle
 * switch) so the Settings page reads consistently. Each row represents one
 * env-provider plugin; users can toggle individual providers off (e.g. a
 * repo has both mise.toml and flake.nix but the user only wants the Nix
 * devshell active) without touching the others.
 *
 * The "Reload" footer button evicts the backend cache for every provider
 * in this workspace — useful after running `direnv allow` / `mise trust`
 * outside Claudette and wanting the new state reflected immediately.
 */
export function WorkspaceEnvPanel({ workspaceId }: WorkspaceEnvPanelProps) {
  const [sources, setSources] = useState<EnvSourceInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await getWorkspaceEnvSources(workspaceId);
      setSources(result);
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleReloadAll = useCallback(async () => {
    try {
      await reloadWorkspaceEnv(workspaceId);
      await refresh();
    } catch (e) {
      setFetchError(String(e));
    }
  }, [workspaceId, refresh]);

  const handleToggle = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setEnvProviderEnabled(workspaceId, pluginName, nextEnabled);
        await refresh();
      } catch (e) {
        setFetchError(String(e));
      }
    },
    [workspaceId, refresh],
  );

  if (fetchError) {
    return (
      <div className={styles.mcpError} role="alert">
        Failed to load environment providers: {fetchError}
      </div>
    );
  }

  if (loading && sources === null) {
    return <div className={styles.settingDescription}>Loading…</div>;
  }

  if (!sources || sources.length === 0) {
    return (
      <div className={styles.settingDescription}>
        No environment providers installed.
      </div>
    );
  }

  return (
    <>
      <div className={styles.settingDescription}>
        Tools whose env is merged into every subprocess Claudette spawns
        for this workspace. Cached results invalidate automatically when
        watched files (<code>.envrc</code>, <code>mise.toml</code>,{" "}
        <code>.env</code>, <code>flake.lock</code>) change.
      </div>

      <div className={styles.mcpList}>
        {sources.map((source) => (
          <div key={source.plugin_name} className={styles.mcpRow}>
            <div className={styles.mcpInfo}>
              <span
                className={styles.mcpStatusDot}
                style={{ background: stateColor(source) }}
                title={stateBadge(source)}
              />
              <span
                className={`${styles.mcpName} ${!source.enabled ? styles.mcpNameDisabled : ""}`}
              >
                {source.display_name}
              </span>
              <span className={styles.mcpBadge}>{stateBadge(source)}</span>
              {source.enabled && source.detected && !source.error && (
                <span className={styles.settingDescription}>
                  {source.vars_contributed} var
                  {source.vars_contributed === 1 ? "" : "s"}
                  {source.evaluated_at_ms > 0 && (
                    <> · {formatRelativeTime(source.evaluated_at_ms)}</>
                  )}
                </span>
              )}
              {source.enabled && source.error && source.error !== "disabled" && (
                <span
                  className={styles.mcpError}
                  title={source.error}
                >
                  {source.error.slice(0, 60)}
                </span>
              )}
            </div>
            <div className={styles.mcpActions}>
              <button
                type="button"
                className={`${styles.mcpToggle} ${source.enabled ? styles.mcpToggleOn : ""}`}
                onClick={() => handleToggle(source.plugin_name, !source.enabled)}
                role="switch"
                aria-checked={source.enabled}
                aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.display_name}`}
              >
                <span className={styles.mcpToggleKnob} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handleReloadAll}
          disabled={loading}
        >
          {loading ? "Reloading…" : "Reload"}
        </button>
      </div>
    </>
  );
}
