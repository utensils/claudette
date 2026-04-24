import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getEnvSources,
  reloadEnv,
  runEnvTrust,
  setEnvProviderEnabled,
} from "../../../services/env";
import { listClaudettePlugins } from "../../../services/claudettePlugins";
import type { EnvSourceInfo, EnvTarget } from "../../../types/env";
import styles from "../Settings.module.css";

interface ErrorInsight {
  summary: string;
  suggestedCommand?: string;
  suggestedDescription?: string;
}

/**
 * Extract a human summary + optional fix suggestion from a raw Lua runtime
 * error string. Handles the common remediable cases surfaced by bundled
 * env providers:
 *
 *   - mise: `are not trusted` → suggest `mise trust`
 *   - direnv: `.envrc is blocked` → suggest `direnv allow`
 *   - nix-devshell: flake eval failure → no suggestion, just the core message
 *
 * Falls back to the first meaningful line of the error with Lua traceback
 * boilerplate stripped, so users see a readable message even when we don't
 * have a canned hint.
 */
function analyzeError(pluginName: string, err: string): ErrorInsight {
  // Gate the canned "Run this to fix it" hints on the plugin id so a
  // third-party plugin whose error text happens to contain "not trusted"
  // or "is blocked" doesn't get a wrong mise/direnv suggestion.
  if (pluginName === "env-mise" && /not trusted|mise trust/i.test(err)) {
    return {
      summary: "mise config files in this workspace are not trusted.",
      suggestedCommand: "mise trust",
      suggestedDescription: "Run in the workspace to authorize mise config:",
    };
  }
  if (pluginName === "env-direnv" && /is blocked|direnv allow/i.test(err)) {
    return {
      summary: ".envrc is blocked — direnv needs explicit permission.",
      suggestedCommand: "direnv allow",
      suggestedDescription: "Run in the workspace to allow direnv:",
    };
  }
  if (pluginName === "env-nix-devshell" && /flake|nix/i.test(err)) {
    return {
      summary: "`nix print-dev-env` failed to evaluate the devshell.",
    };
  }

  const cleaned = err
    .replace(/^\[string "[^"]*"\]:\d+:\s*/, "")
    .replace(/^plugin script error:\s*runtime error:\s*/i, "")
    .trim();
  const afterFailed = /(?:failed|error):\s*(.+)/is.exec(cleaned);
  const core = (afterFailed ? afterFailed[1] : cleaned).split("\n")[0];
  return { summary: core.slice(0, 240) };
}

interface EnvPanelProps {
  target: EnvTarget;
}

/**
 * Pattern-match an error to a plugin name that supports the one-click
 * trust Run button. Returns `null` for plugins/errors we don't have a
 * canned fix for — the UI still shows the Copy button in those cases.
 */
function trustablePluginFromError(
  pluginName: string,
  error: string,
): "env-direnv" | "env-mise" | null {
  if (pluginName === "env-mise" && /not trusted|mise trust/i.test(error)) {
    return "env-mise";
  }
  if (pluginName === "env-direnv" && /is blocked|direnv allow/i.test(error)) {
    return "env-direnv";
  }
  return null;
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
export function EnvPanel({ target }: EnvPanelProps) {
  const [sources, setSources] = useState<EnvSourceInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runningTrust, setRunningTrust] = useState<string | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  // Becomes true after the first successful `getEnvSources` resolve for
  // the current target. While false, any rows we're showing came from
  // the cheap placeholder fetch and don't yet reflect per-repo toggle
  // state — so we lock per-row toggles to avoid the user acting on a
  // placeholder value.
  const [resolvedOnce, setResolvedOnce] = useState(false);

  const toggleExpanded = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await getEnvSources(target);
      setSources(result);
      setResolvedOnce(true);
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setLoading(false);
    }
  }, [target]);

  // Kick off a cheap registry-only fetch in parallel with the resolve
  // pass so the toggle rows appear instantly, even on a fresh mount
  // where the full resolve (direnv/nix/mise) can take seconds. The
  // resolve result replaces the placeholder rows once it completes.
  // Reset panel state whenever the target changes. Without this, rows
  // from the previous repo/workspace linger until refresh() resolves,
  // and the placeholder fetch won't replace them because it only fills
  // when sources===null. Clearing expanded/trustError too avoids
  // surfacing error details from a different target.
  useEffect(() => {
    setResolvedOnce(false);
    setSources(null);
    setExpanded(new Set());
    setTrustError(null);
  }, [target]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const plugins = await listClaudettePlugins();
        if (cancelled) return;
        setSources((prev) => {
          // If the resolve pass already populated us (fast repo), keep it.
          if (prev !== null) return prev;
          return plugins
            .filter((p) => p.kind === "env-provider" && p.enabled)
            .map<EnvSourceInfo>((p) => ({
              plugin_name: p.name,
              display_name: p.display_name,
              detected: false,
              enabled: true,
              vars_contributed: 0,
              cached: false,
              evaluated_at_ms: 0,
              error: null,
            }));
        });
      } catch {
        // Listing is best-effort scaffolding; the real resolve path
        // below will surface any fetch error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reactive invalidation: when the Rust-side fs watcher detects that
  // a plugin's watched file changed (user edited `.envrc`, ran
  // `direnv allow`, modified `flake.lock`, etc.), the backend emits
  // `env-cache-invalidated`. We refetch so the panel shows fresh
  // vars_contributed counts without the user having to click Reload.
  //
  // Debounced because editors often save + swap + touch, firing the
  // event 2-3 times in rapid succession. 300ms coalesces the bursts
  // into a single re-resolve.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    (async () => {
      try {
        unlisten = await listen("env-cache-invalidated", () => {
          if (cancelled) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refresh();
          }, 300);
        });
      } catch {
        // Listen failure means the event bridge isn't wired up — fall
        // back to the existing manual Reload button. Silent is fine.
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh]);

  const handleReloadAll = useCallback(async () => {
    try {
      await reloadEnv(target);
      await refresh();
    } catch (e) {
      setFetchError(String(e));
    }
  }, [target, refresh]);

  const handleToggle = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setEnvProviderEnabled(target, pluginName, nextEnabled);
        await refresh();
      } catch (e) {
        setFetchError(String(e));
      }
    },
    [target, refresh],
  );

  const handleRunTrust = useCallback(
    async (pluginName: string) => {
      setRunningTrust(pluginName);
      setTrustError(null);
      try {
        await runEnvTrust(target, pluginName);
        await refresh();
      } catch (e) {
        setTrustError(String(e));
      } finally {
        setRunningTrust(null);
      }
    },
    [target, refresh],
  );

  if (fetchError) {
    return (
      <div className={styles.mcpError} role="alert">
        Failed to load environment providers: {fetchError}
      </div>
    );
  }

  // Only show the blanking "Loading…" in the edge case where BOTH the
  // placeholder-list fetch and the resolve fetch are still pending —
  // otherwise the placeholder rows let the user see + toggle providers
  // immediately.
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
        for this {target.kind === "repo" ? "repository" : "workspace"}.
        Cached results invalidate automatically when watched files
        (<code>.envrc</code>, <code>mise.toml</code>, <code>.env</code>,{" "}
        <code>flake.lock</code>) change.
      </div>

      <div className={styles.mcpList}>
        {sources.map((source) => {
          const hasError =
            source.enabled && !!source.error && source.error !== "disabled";
          const isOpen = expanded.has(source.plugin_name);
          return (
            <div key={source.plugin_name}>
              <div className={styles.mcpRow}>
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
                </div>
                <div className={styles.mcpActions}>
                  {hasError && (
                    <button
                      type="button"
                      className={styles.envDetailsBtn}
                      onClick={() => toggleExpanded(source.plugin_name)}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? "Hide details" : "Show details"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.mcpToggle} ${source.enabled ? styles.mcpToggleOn : ""}`}
                    onClick={() =>
                      handleToggle(source.plugin_name, !source.enabled)
                    }
                    role="switch"
                    aria-checked={source.enabled}
                    aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.display_name}`}
                    disabled={!resolvedOnce}
                    title={
                      !resolvedOnce
                        ? "Resolving environment providers…"
                        : undefined
                    }
                  >
                    <span className={styles.mcpToggleKnob} />
                  </button>
                </div>
              </div>
              {hasError && isOpen && (
                <ErrorCard
                  pluginName={source.plugin_name}
                  error={source.error!}
                  trustablePlugin={trustablePluginFromError(
                    source.plugin_name,
                    source.error!,
                  )}
                  running={runningTrust === source.plugin_name}
                  onRunTrust={() => handleRunTrust(source.plugin_name)}
                />
              )}
            </div>
          );
        })}
      </div>

      {trustError && (
        <div className={styles.mcpError} role="alert">
          Trust command failed: {trustError}
        </div>
      )}

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

function ErrorCard({
  pluginName,
  error,
  trustablePlugin,
  running,
  onRunTrust,
}: {
  pluginName: string;
  error: string;
  trustablePlugin: "env-direnv" | "env-mise" | null;
  running: boolean;
  onRunTrust: () => void;
}) {
  const insight = analyzeError(pluginName, error);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  // Track the "Copied" flag reset timer per-flag so a fast second copy
  // (or an unmount from collapsing/target-change) cancels the pending
  // setState instead of firing after the component is gone.
  const cmdResetRef = useRef<number | null>(null);
  const rawResetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (cmdResetRef.current !== null) {
        window.clearTimeout(cmdResetRef.current);
      }
      if (rawResetRef.current !== null) {
        window.clearTimeout(rawResetRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    async (
      text: string,
      setFlag: (v: boolean) => void,
      timerRef: React.MutableRefObject<number | null>,
    ) => {
      try {
        await writeText(text);
        setFlag(true);
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
          setFlag(false);
          timerRef.current = null;
        }, 1500);
      } catch {
        // Clipboard access can fail in hardened webviews; silently no-op —
        // the raw text is still visible in the <pre> for manual selection.
      }
    },
    [],
  );

  return (
    <div className={styles.envErrorCard} role="alert">
      <div className={styles.envErrorSummary}>{insight.summary}</div>
      {insight.suggestedCommand && (
        <>
          {insight.suggestedDescription && (
            <div className={styles.envErrorHint}>
              {insight.suggestedDescription}
            </div>
          )}
          <div className={styles.envErrorCmdRow}>
            <code className={styles.envErrorCmd}>
              {insight.suggestedCommand}
            </code>
            {trustablePlugin && (
              <button
                type="button"
                className={styles.envErrorRunBtn}
                onClick={onRunTrust}
                disabled={running}
                title="Run this command in the workspace from Claudette"
              >
                {running ? "Running…" : "Run"}
              </button>
            )}
            <button
              type="button"
              className={styles.envErrorCopyBtn}
              onClick={() =>
                copy(insight.suggestedCommand!, setCopiedCmd, cmdResetRef)
              }
            >
              {copiedCmd ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
      <details className={styles.envErrorDetails}>
        <summary>Raw error output</summary>
        <pre className={styles.envErrorPre}>{error}</pre>
        <button
          type="button"
          className={styles.envErrorCopyBtn}
          onClick={() => copy(error, setCopiedRaw, rawResetRef)}
        >
          {copiedRaw ? "Copied" : "Copy full error"}
        </button>
      </details>
    </div>
  );
}
