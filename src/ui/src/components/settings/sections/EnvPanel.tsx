import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../../../stores/useAppStore";
import {
  getEnvSources,
  getEnvTargetWorktree,
  reloadEnv,
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
import { classifyPostActionError } from "../../modals/EnvTrustModal";
import { summarizeError } from "../../modals/envTrustFormat";
import styles from "../Settings.module.css";

interface EnvPanelProps {
  target: EnvTarget;
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

/** Detect whether a row's error string is a trust-class failure (one
 *  the EnvTrustModal can actually resolve via mise trust / direnv allow).
 *  Wraps `classifyPostActionError` so EnvPanel reuses the same matcher
 *  the modal uses for post-action verification — keeps both surfaces
 *  agreeing on what counts as "trust class". */
function isTrustClassError(error: string | null | undefined): boolean {
  if (!error) return false;
  return (
    classifyPostActionError({ error }).kind === "still-blocked"
  );
}

// summarizeError lives in ../../modals/envTrustFormat so both this
// proactive entry point and the event-driven modal share the same
// cleaner. See its module doc for the strip-order contract.

/**
 * Environment providers panel for a workspace.
 *
 * Mirrors the MCP servers list pattern (mcpRow/mcpInfo/mcpActions + toggle
 * switch) so the Settings page reads consistently. Each row represents one
 * env-provider plugin; users can toggle individual providers off (e.g. a
 * repo has both mise.toml and flake.nix but the user only wants the Nix
 * devshell active) without touching the others.
 *
 * Trust-class failures (mise untrusted, direnv blocked) route through
 * the shared EnvTrustModal — same flow whether the failure was caught
 * proactively by `prepare_workspace_environment` or surfaced by the
 * user toggling a provider back on from this panel. Keeping the trust
 * UI in one component (instead of inline-in-row buttons) avoids the
 * "two paths that drift" problem we hit before this refactor.
 *
 * Non-trust errors (broken TOML, flake eval failure) still surface
 * inline through a small "Details" disclosure — the modal isn't the
 * right surface for those, and re-running the trust command wouldn't
 * help anyway.
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
  const repoIdForOverrides =
    target.kind === "repo" ? target.repo_id : null;

  // Key the env-progress store lookup the same way the dispatcher
  // emits events: workspace targets use the workspace_id; repo
  // targets use a synthetic `repo:{id}` key. This matches what
  // `prepare_workspace_environment` / `get_env_sources` send through
  // `TauriEnvProgressSink` so the panel can render the same
  // "Loading env-direnv (Ns)…" hint the sidebar shows.
  const envProgressKey =
    target.kind === "workspace"
      ? target.workspace_id
      : `repo:${target.repo_id}`;
  const envProgress = useAppStore(
    (s) => s.workspaceEnvironment?.[envProgressKey],
  );
  // Resolve the repo this panel is acting on so trust-modal callers
  // always have a repo_id, even in workspace-target mode. The trust
  // decision applies to the repository; the workspace is just the
  // probe point. Falls back to null if we can't find the workspace
  // (rare — would mean a stale settings panel referencing a deleted
  // workspace), in which case the inline trust button is suppressed.
  const repoIdForModal = useAppStore((s) => {
    if (target.kind === "repo") return target.repo_id;
    return (
      s.workspaces.find((w) => w.id === target.workspace_id)?.repository_id ??
      null
    );
  });
  const openModal = useAppStore((s) => s.openModal);
  // We watch this transition to know when EnvTrustModal closes (auto-
  // close on resolve, Cancel, or user-driven Disable) so the panel can
  // re-fetch sources — otherwise a successfully-trusted row keeps
  // showing ERROR because runEnvTrust / setEnvProviderEnabled don't
  // fire `env-cache-invalidated` themselves. Caught in UAT after the
  // initial refactor: click Resolve → Trust → modal closes → click
  // Resolve again on the same row → modal pops back up off stale
  // data. Codex P2 flagged the same regression independently.
  const activeModal = useAppStore((s) => s.activeModal);

  // Tick once a second while a resolve is in flight so the elapsed
  // counter updates without each render computing it on its own.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (envProgress?.status !== "preparing" || !envProgress.started_at) {
      setElapsedSec(0);
      return;
    }
    const startedAt = envProgress.started_at;
    setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [envProgress?.status, envProgress?.started_at]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await getEnvSources(target);
      setSources(result);
      setResolvedOnce(true);
      return result;
    } catch (e) {
      setFetchError(String(e));
      return null;
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
  // when sources===null. Clearing expanded too avoids surfacing error
  // details from a different target.
  useEffect(() => {
    setResolvedOnce(false);
    setSources(null);
    setExpanded(new Set());
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

  // Refresh whenever EnvTrustModal closes. The effect's setup arm fires
  // when activeModal becomes "envTrust"; the cleanup arm fires when it
  // changes away from that — closing, switching to another modal, or
  // unmounting EnvPanel. We refresh on cleanup so the user sees the
  // updated row state (TRUSTED ⇒ "fresh"/"cached" pill, DISABLED ⇒
  // "disabled" pill) the moment the modal disappears. Cheap — the
  // dispatcher serves from cache when trust state didn't actually
  // change (e.g. Cancel).
  useEffect(() => {
    if (activeModal !== "envTrust") return;
    return () => {
      void refresh();
    };
  }, [activeModal, refresh]);

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

  /**
   * Open the EnvTrustModal for one specific provider. Builds the same
   * payload shape the `workspace_env_trust_needed` event would send,
   * but with `workspace_id: null` so the modal verifies against the
   * repo target instead of a (possibly missing) workspace. Caller is
   * responsible for confirming `repoIdForModal` is non-null and that
   * the source actually has a trust-class error.
   */
  const openTrustModalForPlugin = useCallback(
    (source: EnvSourceInfo) => {
      if (!repoIdForModal) return;
      const errorText = source.error ?? "";
      openModal("envTrust", {
        // When the panel is viewing a workspace target we DO have a
        // workspace_id, so wire it through — the modal can then
        // re-resolve + re-prepare the failing workspace so the user
        // gets immediate feedback in the chat composer. In repo mode
        // we pass null and the modal degrades to repo-scope verify.
        workspace_id:
          target.kind === "workspace" ? target.workspace_id : null,
        repo_id: repoIdForModal,
        plugins: [
          {
            plugin_name: source.plugin_name,
            message: summarizeError(errorText),
            config_path: null,
            error_excerpt: errorText,
          },
        ],
      });
    },
    [openModal, repoIdForModal, target],
  );

  const handleToggle = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setEnvProviderEnabled(target, pluginName, nextEnabled);
        // Re-fetch sources inline (rather than fire-and-forget
        // `refresh()`) so we can immediately inspect whether the
        // toggle-on revealed a trust error and prompt the user via
        // the modal. The refresh() helper also updates panel state
        // for us, so the toggle reflects reality the moment we return.
        const fresh = await refresh();
        if (nextEnabled && fresh && repoIdForModal) {
          const row = fresh.find((s) => s.plugin_name === pluginName);
          // Only open the modal when the row reports a trust-class
          // error AND the provider's CLI is actually installed.
          // "Unavailable" rows can't be resolved by trust — the user
          // needs to install the tool first, and the modal would be
          // misleading.
          if (row && !row.unavailable && isTrustClassError(row.error)) {
            openTrustModalForPlugin(row);
          }
        }
      } catch (e) {
        setFetchError(String(e));
      }
    },
    [target, refresh, repoIdForModal, openTrustModalForPlugin],
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

  const toggleExpanded = useCallback(
    (name: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
          // Lazy-load per-repo override values for the plugin's
          // settings form on first open.
          void ensureOverridesLoaded(name);
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

      {envProgress?.status === "preparing" && envProgress.current_plugin && (
        <div
          className={styles.settingDescription}
          role="status"
          aria-live="polite"
        >
          {/* Cold flakes (use_flake / nix print-dev-env) routinely run
              60–120s on first hit. Without this inline hint, the
              disabled toggles + tooltip ("Resolving environment
              providers…") look indistinguishable from a hang — the
              user reported exactly that mismatch. Surfacing the
              active plugin + elapsed counter mirrors the sidebar's
              loading hint so the same data shows up wherever a
              resolve is visible. */}
          Resolving <strong>{envProgress.current_plugin}</strong>… {elapsedSec}
          s elapsed
          {elapsedSec > 30 && (
            <> · cold flakes can take 60–120 seconds on first run</>
          )}
        </div>
      )}

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
          const trustError = hasError && isTrustClassError(source.error);
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
          //      surfacing the form would mislead the user.
          //   3. The manifest declares at least one user-facing
          //      setting; otherwise there's nothing to render.
          const info = pluginInfo[source.plugin_name];
          const showSettings =
            !!repoIdForOverrides &&
            !!info &&
            info.enabled &&
            info.settings_schema.length > 0;
          // Non-trust errors get an inline "Details" disclosure — the
          // modal isn't the right surface for broken TOML / flake
          // eval failures, and there's no canned fix to offer.
          const showDetails = hasError && !trustError;
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
                  {/* Trust-class error → primary action opens the
                      shared EnvTrustModal. Same UX whether the error
                      was surfaced by a failing workspace prepare or by
                      toggling a provider back on with a stale untrust
                      state. We only surface the button when we have a
                      repo_id to scope the trust decision to (every
                      target normally does; the guard is for safety). */}
                  {trustError && repoIdForModal && (
                    <button
                      type="button"
                      className={styles.envDetailsBtn}
                      onClick={() => openTrustModalForPlugin(source)}
                      title="Open the trust prompt for this provider"
                    >
                      Resolve…
                    </button>
                  )}
                  {(showSettings || showDetails) && (
                    <button
                      type="button"
                      className={styles.envDetailsBtn}
                      onClick={() => toggleExpanded(source.plugin_name)}
                      aria-expanded={isOpen}
                    >
                      {isOpen
                        ? "Hide"
                        : showSettings
                          ? "Settings"
                          : "Details"}
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
              {isOpen && showDetails && (
                <pre className={styles.envErrorPre}>{source.error}</pre>
              )}
              {isOpen && showSettings && (
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
