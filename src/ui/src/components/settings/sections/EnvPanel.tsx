import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import {
  getEnvSources,
  getEnvTargetWorktree,
  reloadEnv,
  runEnvTrust,
  setEnvProviderEnabled,
} from "../../../services/env";
import {
  getClaudettePluginRepoSettings,
  listClaudettePlugins,
  setClaudettePluginRepoSetting,
} from "../../../services/claudettePlugins";
import type {
  ClaudettePluginInfo,
  PluginSettingField,
} from "../../../types/claudettePlugins";
import type { EnvSourceInfo, EnvTarget } from "../../../types/env";
import { PluginSettingInput } from "../PluginSettingInput";
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
 *   dim    — not detected, disabled, OR required CLI not installed
 */
function stateColor(source: EnvSourceInfo): string {
  if (source.unavailable) return "var(--text-faint)";
  if (!source.enabled) return "var(--text-faint)";
  if (source.error) return "var(--status-stopped)";
  if (!source.detected) return "var(--text-faint)";
  return source.cached ? "var(--status-idle)" : "var(--status-running)";
}

function stateBadge(source: EnvSourceInfo): string {
  // "not installed" is a system-capability state — distinct from
  // "disabled" (user toggled off) so users know whether the fix is
  // toggling Claudette or installing the underlying tool.
  if (source.unavailable) return "not installed";
  if (!source.enabled) return "disabled";
  if (source.error) return "error";
  if (!source.detected) return "not detected";
  return source.cached ? "cached" : "fresh";
}

/**
 * Required-CLI hint per bundled provider — names the tool the user
 * needs to install for the plugin to apply. Returned as the toggle's
 * tooltip when the plugin is in the `unavailable` state. Generic
 * fallback for third-party providers names "the required CLI" so we
 * never claim it's a specific tool we don't know about.
 */
function unavailableTooltip(pluginName: string): string {
  // CLI availability is probed once at PluginRegistry discovery; the
  // user has to restart Claudette to pick up a newly-installed tool.
  // Be explicit so the toggle's tooltip doesn't promise live recovery.
  const restartHint = "Install it and restart Claudette to enable this provider.";
  switch (pluginName) {
    case "env-nix-devshell":
      return `Install \`nix\` and restart Claudette to enable this provider.`;
    case "env-mise":
      return `Install \`mise\` and restart Claudette to enable this provider.`;
    case "env-direnv":
      return `Install \`direnv\` and restart Claudette to enable this provider.`;
    default:
      return `The required CLI for this provider is not on PATH. ${restartHint}`;
  }
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
  // Per-plugin manifest info (settings_schema, globally-enabled flag,
  // current effective values). We keep this map alongside the
  // resolved-sources rows so each row can render its per-repo
  // settings form inline — keeping all per-provider concerns
  // (status, enable toggle, settings overrides) in one card instead
  // of as a separate "Env provider overrides" section beneath.
  const [pluginInfo, setPluginInfo] = useState<
    Record<string, ClaudettePluginInfo>
  >({});
  // Per-repo override values for each plugin's settings, lazily loaded
  // on first expansion of the row's settings drawer. Shape: `{ plugin
  // -> { key -> value } }`.
  const [repoOverrides, setRepoOverrides] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [overridesLoaded, setOverridesLoaded] = useState<Set<string>>(
    new Set(),
  );
  // Two independent expansion sets — errors and settings can be open
  // simultaneously without one toggling the other.
  const [expandedSettings, setExpandedSettings] = useState<Set<string>>(
    new Set(),
  );

  const repoIdForOverrides =
    target.kind === "repo" ? target.repo_id : null;

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
    setExpandedSettings(new Set());
    setTrustError(null);
    setRepoOverrides({});
    setOverridesLoaded(new Set());
  }, [target]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const plugins = await listClaudettePlugins();
        if (cancelled) return;
        // Snapshot the env-provider manifests so the per-row settings
        // drawer can render its form without an extra fetch. We index
        // by name so the row JSX can do an O(1) lookup; we keep ALL
        // env-providers (even disabled) so the form's `enabled` filter
        // is the single source of truth, not an upstream slice.
        const byName: Record<string, ClaudettePluginInfo> = {};
        for (const p of plugins) {
          if (p.kind === "env-provider") {
            byName[p.name] = p;
          }
        }
        setPluginInfo(byName);
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
              // Placeholder rows pre-resolve. The real resolve fills in
              // the actual unavailable state from the registry's CLI
              // probe; until then assume installed so we don't flicker
              // a "not installed" badge for a tool the user does have.
              unavailable: false,
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
  // `env-cache-invalidated` with the worktree path that changed. We
  // filter against our own target's worktree so an edit in repo B
  // doesn't make the panel viewing repo A rerun direnv/nix/mise.
  //
  // Debounced because editors often save + swap + touch, firing the
  // event 2-3 times in rapid succession. 300ms coalesces the bursts
  // into a single re-resolve.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    (async () => {
      let targetWorktree: string | null = null;
      try {
        targetWorktree = await getEnvTargetWorktree(target);
      } catch {
        // If we can't resolve the target's worktree we can't filter
        // — leave reactive invalidation off for this target rather
        // than triggering refreshes for every unrelated edit.
        return;
      }
      if (cancelled) return;
      try {
        unlisten = await listen<{
          worktree_path: string;
          plugin_name: string;
        }>("env-cache-invalidated", (event) => {
          if (cancelled) return;
          if (event.payload.worktree_path !== targetWorktree) return;
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
  }, [target, refresh]);

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

  // Lazy-load a plugin's per-repo overrides on first expansion. Saves a
  // round trip per plugin until the user actually opens the drawer.
  const ensureOverridesLoaded = useCallback(
    async (pluginName: string) => {
      if (!repoIdForOverrides) return;
      if (overridesLoaded.has(pluginName)) return;
      try {
        const overrides = await getClaudettePluginRepoSettings(
          repoIdForOverrides,
          pluginName,
        );
        setRepoOverrides((prev) => ({ ...prev, [pluginName]: overrides }));
        setOverridesLoaded((prev) => {
          const next = new Set(prev);
          next.add(pluginName);
          return next;
        });
      } catch {
        // Best-effort — the form falls back to manifest defaults if
        // we can't load the per-repo overrides, and the next mount
        // will retry.
      }
    },
    [repoIdForOverrides, overridesLoaded],
  );

  const toggleSettings = useCallback(
    (pluginName: string) => {
      setExpandedSettings((prev) => {
        const next = new Set(prev);
        if (next.has(pluginName)) {
          next.delete(pluginName);
        } else {
          next.add(pluginName);
          void ensureOverridesLoaded(pluginName);
        }
        return next;
      });
    },
    [ensureOverridesLoaded],
  );

  const handleSettingChange = useCallback(
    async (pluginName: string, key: string, value: unknown) => {
      if (!repoIdForOverrides) return;
      try {
        await setClaudettePluginRepoSetting(
          repoIdForOverrides,
          pluginName,
          key,
          value,
        );
        // Optimistic update — match RepoEnvProviderSettings semantics:
        // `null` means "use global default", drop the key from the
        // override map so the form falls back to the global value.
        setRepoOverrides((prev) => {
          const nextPlugin = { ...(prev[pluginName] ?? {}) };
          if (value === null) {
            delete nextPlugin[key];
          } else {
            nextPlugin[key] = value;
          }
          return { ...prev, [pluginName]: nextPlugin };
        });
      } catch (e) {
        setFetchError(String(e));
      }
    },
    [repoIdForOverrides],
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
          // `unavailable` is a system-capability state — the plugin's
          // CLI isn't on PATH, so there is no error to expand and the
          // toggle is meaningless until the user installs the tool.
          const hasError =
            source.enabled &&
            !source.unavailable &&
            !!source.error &&
            source.error !== "disabled";
          const isOpen = expanded.has(source.plugin_name);
          // Treat the toggle as locked-off while unavailable: visually
          // off, non-actionable, and tooltip points at the fix
          // (install the missing CLI, then restart Claudette to
          // re-probe PATH). The per-repo `enabled` setting is left
          // untouched so the user's intent survives the install +
          // restart cycle without forcing them to re-toggle.
          const toggleOn = source.enabled && !source.unavailable;
          const toggleDisabled = !resolvedOnce || source.unavailable;
          const toggleTitle = source.unavailable
            ? unavailableTooltip(source.plugin_name)
            : !resolvedOnce
              ? "Resolving environment providers…"
              : undefined;
          // Show the inline Settings drawer only when:
          //   1. We're in repo mode (per-repo overrides only make
          //      sense scoped to a repository).
          //   2. The plugin is globally enabled — disabled plugins
          //      won't run regardless of any per-repo override, so
          //      surfacing the form would mislead the user (matches
          //      the rule the standalone RepoEnvProviderSettings
          //      panel enforced before this UX merge).
          //   3. The manifest declares at least one user-facing
          //      setting; otherwise there's nothing to render.
          const info = pluginInfo[source.plugin_name];
          const showSettings =
            !!repoIdForOverrides &&
            !!info &&
            info.enabled &&
            info.settings_schema.length > 0;
          const settingsOpen = expandedSettings.has(source.plugin_name);
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
                    className={`${styles.mcpName} ${!source.enabled || source.unavailable ? styles.mcpNameDisabled : ""}`}
                  >
                    {source.display_name}
                  </span>
                  <span
                    className={styles.mcpBadge}
                    title={
                      source.unavailable
                        ? unavailableTooltip(source.plugin_name)
                        : undefined
                    }
                  >
                    {stateBadge(source)}
                  </span>
                  {source.enabled &&
                    !source.unavailable &&
                    source.detected &&
                    !source.error && (
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
                  {showSettings && (
                    <button
                      type="button"
                      className={styles.envDetailsBtn}
                      onClick={() => toggleSettings(source.plugin_name)}
                      aria-expanded={settingsOpen}
                    >
                      {settingsOpen ? "Hide settings" : "Settings"}
                    </button>
                  )}
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
                    className={`${styles.mcpToggle} ${toggleOn ? styles.mcpToggleOn : ""}`}
                    onClick={() =>
                      handleToggle(source.plugin_name, !source.enabled)
                    }
                    role="switch"
                    aria-checked={toggleOn}
                    aria-label={`${toggleOn ? "Disable" : "Enable"} ${source.display_name}`}
                    disabled={toggleDisabled}
                    title={toggleTitle}
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
              {showSettings && settingsOpen && (
                <ProviderSettingsDrawer
                  schema={info!.settings_schema}
                  globalValues={info!.setting_values}
                  overrides={repoOverrides[source.plugin_name] ?? {}}
                  onChange={(key, value) =>
                    handleSettingChange(source.plugin_name, key, value)
                  }
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
  // Two independent hook instances so the "Copied" flag tracks per button
  // (the suggested command and the raw error each get their own timer).
  const { copied: copiedCmd, copy: copyCmd } = useCopyToClipboard();
  const { copied: copiedRaw, copy: copyRaw } = useCopyToClipboard();

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
              onClick={() => void copyCmd(insight.suggestedCommand!)}
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
          onClick={() => void copyRaw(error)}
        >
          {copiedRaw ? "Copied" : "Copy full error"}
        </button>
      </details>
    </div>
  );
}

/**
 * Inline drawer that renders a plugin's manifest settings as a form
 * scoped to one repository. Each input shows the per-repo override
 * when present, falling back to the global value Claudette would
 * otherwise apply (so the user always sees what would actually take
 * effect). A "Use global default" affordance appears next to any
 * field with an active per-repo override and clears it on click.
 *
 * Lives next to EnvPanel rather than as a standalone settings page
 * so each provider's status, enable toggle, and config knobs sit in
 * one card — Repo Settings used to render this list as a separate
 * "Env provider overrides" section beneath the Environment status,
 * which duplicated the provider list and confused which scope each
 * toggle controlled.
 */
function ProviderSettingsDrawer({
  schema,
  globalValues,
  overrides,
  onChange,
}: {
  schema: PluginSettingField[];
  globalValues: Record<string, unknown>;
  overrides: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className={styles.envSettingsDrawer}>
      {schema.map((field) => {
        const overrideValue = overrides[field.key];
        const overridden = overrideValue !== undefined;
        // When no override exists, show the global value so the user
        // can see what the workspace would inherit; when overridden,
        // show the override value so editing it is direct.
        const displayValue = overridden
          ? overrideValue
          : globalValues[field.key];
        return (
          <div
            key={field.key}
            className={
              overridden
                ? `${styles.envSettingsField} ${styles.envSettingsFieldOverridden}`
                : styles.envSettingsField
            }
          >
            <PluginSettingInput
              field={field}
              value={displayValue}
              onChange={(value) => onChange(field.key, value)}
            />
            {overridden && (
              <button
                type="button"
                className={styles.envSettingsClearBtn}
                onClick={() => onChange(field.key, null)}
                title="Clear this repo's override and use the global default"
              >
                Use global default
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
