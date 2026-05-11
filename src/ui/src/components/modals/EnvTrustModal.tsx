import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { Modal } from "./Modal";
import {
  envTargetFromRepo,
  envTargetFromWorkspace,
  getEnvSources,
  reloadEnv,
  runEnvTrust,
  setEnvProviderEnabled,
} from "../../services/env";
import { setClaudettePluginRepoSetting } from "../../services/claudettePlugins";
import { prepareWorkspaceEnvironment } from "../../services/tauri";
import { formatElapsed } from "./envTrustFormat";
import shared from "./shared.module.css";
import styles from "./EnvTrustModal.module.css";

/**
 * Trust/Disable can take 15-30s on a project with many worktrees —
 * `run_env_trust` fans out the trust command (mise trust / direnv
 * allow) to every existing worktree under the repo, then we re-resolve
 * + verify. The phase string lets the modal show "Running `direnv
 * allow`…" / "Re-resolving environment…" / "Verifying…" inline so the
 * user sees what we're actually doing instead of a static "Trusting…".
 */
type ActionPhase = "running" | "reloading" | "verifying";

/**
 * Per-plugin row state — the modal can have several rows in flight at
 * once (mise AND direnv both untrusted on a fresh worktree is common).
 * Each transitions independently as the user clicks Trust / Disable.
 * `startedAt` is wall-clock milliseconds so the button label can show
 * an elapsed-seconds counter (`Trusting… 5s`) ticking once per second.
 */
type RowState =
  | { kind: "idle" }
  | { kind: "trusting"; startedAt: number; phase: ActionPhase }
  | { kind: "disabling"; startedAt: number; phase: ActionPhase }
  | { kind: "trusted" }
  | { kind: "disabled" }
  | { kind: "failed"; error: string };

interface PluginEntry {
  plugin_name: string;
  /** One-line human summary built backend-side (e.g. "mise.toml is not trusted."). */
  message: string;
  /** Absolute config-file path the backend parsed out of the error, if any. */
  config_path?: string | null;
  /** Raw stderr — hidden behind the "Show details" disclosure. */
  error_excerpt: string;
}

export interface EnvTrustModalData {
  /**
   * The workspace whose resolve hit the trust error, if there was one.
   * Set when the modal is triggered by the `workspace_env_trust_needed`
   * Tauri event (a workspace just failed to prepare its env). Null when
   * the modal is triggered proactively from Settings — e.g. the user
   * toggled mise back on at the repo scope and the resolve immediately
   * reported a trust error. In the null case we skip the workspace-
   * scoped reload + re-prepare path and verify success against the repo
   * target instead.
   */
  workspace_id: string | null;
  repo_id: string;
  plugins: PluginEntry[];
}

/**
 * Pure helper exported for tests: returns `true` once every plugin row
 * has reached a terminal user-decision state (trusted OR disabled).
 * `failed` rows hold the modal open so the user can retry; `idle`,
 * `trusting`, and `disabling` rows likewise mean we're still waiting.
 */
export function allRowsResolved(
  plugins: ReadonlyArray<{ plugin_name: string }>,
  rowStates: Readonly<Record<string, { kind: string } | undefined>>,
): boolean {
  if (plugins.length === 0) return false;
  return plugins.every((p) => {
    const k = rowStates[p.plugin_name]?.kind;
    return k === "trusted" || k === "disabled";
  });
}

const PLUGIN_DISPLAY: Record<string, string> = {
  "env-mise": "mise",
  "env-direnv": "direnv",
};

const PLUGIN_TRUST_COMMAND: Record<string, string> = {
  "env-mise": "mise trust",
  "env-direnv": "direnv allow",
};

/**
 * Substrings the Rust `is_trust_error_str` heuristic matches in
 * `src/env_provider/mod.rs`. Mirrored here so we can verify post-action
 * that the plugin we just trusted / disabled actually unblocked — see
 * `classifyPostActionError`. Keep in sync with the Rust list.
 */
const TRUST_ERROR_MARKERS = [
  "not trusted",
  "is blocked",
  "is not allowed",
  "untrusted",
] as const;

/**
 * Classify what the post-action env source row tells us about the
 * plugin's state. Pure — exported for tests; the live modal feeds it
 * the result of `getEnvSources`.
 *
 *   `cleared` — plugin absent from sources, or present with no error,
 *               or present with a non-trust error (the EnvPanel
 *               surfaces those; the modal's job is done).
 *   `still-blocked` — plugin is present and still has a trust-class
 *                     error. The row should stay red so the user
 *                     can retry, instead of going green and the
 *                     modal auto-closing on an action that didn't
 *                     actually take effect.
 */
export function classifyPostActionError(
  source: { error: string | null } | undefined,
): { kind: "cleared" } | { kind: "still-blocked"; error: string } {
  if (!source || !source.error) return { kind: "cleared" };
  const lower = source.error.toLowerCase();
  if (TRUST_ERROR_MARKERS.some((m) => lower.includes(m))) {
    return { kind: "still-blocked", error: source.error };
  }
  return { kind: "cleared" };
}

/**
 * After a Trust/Disable action, re-query env sources to confirm the
 * plugin we acted on is no longer reporting a trust-class error. The
 * backend split returns `Ok(())` from `prepare_workspace_environment`
 * when only trust errors remain (they route through the event), so
 * relying on the resolve's success/failure is not enough — we inspect
 * sources directly. Codex P2 finding (b365f01c review).
 *
 * When `workspaceId` is null (modal opened from Settings without an
 * active workspace) we verify against the repo target — the trust
 * decision applies to the repository, so this is the right scope.
 */
async function verifyPluginCleared(
  workspaceId: string | null,
  repoId: string,
  pluginName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const target =
      workspaceId !== null
        ? envTargetFromWorkspace(workspaceId)
        : envTargetFromRepo(repoId);
    const sources = await getEnvSources(target);
    const result = classifyPostActionError(
      sources.find((s) => s.plugin_name === pluginName),
    );
    return result.kind === "cleared"
      ? { ok: true }
      : { ok: false, error: result.error };
  } catch {
    // `get_env_sources` failure (IPC issue, transient cache problem)
    // shouldn't block the user — fall through to "ok" and let the
    // env-panel reflect any residual issue. Worst case: a green pill
    // on a row that's still blocked, same as before this check
    // existed. We do not regress the prior behavior.
    return { ok: true };
  }
}

export function isEnvTrustModalData(value: unknown): value is EnvTrustModalData {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    // workspace_id is now optional: present + string when triggered by
    // the trust-needed event, null when opened proactively from
    // Settings. Reject `undefined` / wrong type so a malformed event
    // payload still fails the guard.
    (v.workspace_id === null || typeof v.workspace_id === "string") &&
    typeof v.repo_id === "string" &&
    Array.isArray(v.plugins) &&
    v.plugins.every((p): p is PluginEntry => {
      if (p === null || typeof p !== "object") return false;
      const pv = p as Record<string, unknown>;
      return (
        typeof pv.plugin_name === "string" &&
        typeof pv.error_excerpt === "string" &&
        // `message` is required from the new backend; fall back to a
        // truthy check that allows the field to be missing from a
        // stale build's event payload so the frontend doesn't blow up
        // during a partial upgrade.
        (pv.message === undefined || typeof pv.message === "string") &&
        (pv.config_path === undefined ||
          pv.config_path === null ||
          typeof pv.config_path === "string")
      );
    })
  );
}

/**
 * One-time per-project trust prompt for env-provider plugins. Triggered
 * by the `workspace_env_trust_needed` Tauri event whenever
 * `prepare_workspace_environment` detects an untrusted mise / direnv
 * config. Per-row Trust action calls `run_env_trust` (which fans out
 * to repo + every existing worktree) AND persists `repo_trust = allow`
 * so future workspaces in the same repo auto-heal. Per-row Disable
 * action calls `set_env_provider_enabled(false)` for the repo target,
 * which the dispatcher honors before the plugin even runs.
 *
 * Cancel ("Decide later") just dismisses; no decision persists, so the
 * same modal will surface again on the next failing workspace.
 */
export function EnvTrustModal() {
  const { t } = useTranslation("modals");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const repositories = useAppStore((s) => s.repositories);

  const data = isEnvTrustModalData(modalData) ? modalData : null;
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  // Per-row disclosure: hidden by default so the modal stays compact.
  // Users who want to inspect the raw stderr (diagnosing a wedge, or
  // confirming a non-trust failure leaked through the cleaner) can
  // expand it inline without leaving the modal.
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});

  // Per-row guard against double-click while in-flight. The transition
  // back to idle happens through `setState` when the await resolves, so
  // the in-flight checks read off the *current* React state at call
  // time, not a stale snapshot.
  const setRow = useCallback((plugin: string, next: RowState) => {
    setRowStates((s) => ({ ...s, [plugin]: next }));
  }, []);

  // Auto-close once every plugin row has reached a terminal "the user
  // told us their decision" state (trusted OR disabled). Short delay
  // so the user sees the TRUSTED / DISABLED pill flash before the
  // modal disappears, confirming the action took effect. `failed`
  // rows do NOT count — those leave the modal open so the user can
  // retry. Effect re-runs on every rowStates change, but the guard
  // returns early until the modal has data + at least one row, and
  // every row is resolved.
  useEffect(() => {
    if (!data) return;
    if (!allRowsResolved(data.plugins, rowStates)) return;
    const id = setTimeout(closeModal, 600);
    return () => clearTimeout(id);
  }, [data, rowStates, closeModal]);

  // 1Hz ticker that forces a re-render while any row is in flight so
  // the elapsed-seconds counter on the button (and the long-running
  // hint at 10s) update without each consumer wiring its own timer.
  // No-op when nothing is busy — `setInterval` only runs while the
  // user is actually waiting on us.
  const [, tick] = useState(0);
  const anyBusy = Object.values(rowStates).some(
    (s) => s.kind === "trusting" || s.kind === "disabling",
  );
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [anyBusy]);

  /** Phase string for the inline status line under the row actions. */
  const phaseLabel = (
    phase: ActionPhase,
    command: string,
  ): string => {
    if (phase === "running")
      return t("env_trust_progress_phase_running", { command });
    if (phase === "reloading") return t("env_trust_progress_phase_reloading");
    return t("env_trust_progress_phase_verifying");
  };

  const handleTrust = useCallback(
    async (pluginName: string) => {
      if (!data) return;
      const startedAt = Date.now();
      // Phase transitions through `running` (trust command + fan-out)
      // → `reloading` (re-prepare the failing workspace) → `verifying`
      // (re-query sources to confirm the trust took effect). Each
      // transition keeps the same startedAt so the elapsed counter
      // reflects total wall-clock time, not per-phase.
      setRow(pluginName, { kind: "trusting", startedAt, phase: "running" });
      try {
        const repoTarget = envTargetFromRepo(data.repo_id);
        // Run trust first — fan out to every existing worktree under
        // this repo plus the main checkout. If this throws (direnv
        // hiccup, permissions issue) we keep `repo_trust` unwritten so
        // the user can retry.
        await runEnvTrust(repoTarget, pluginName);
        // Persist the user's decision so future workspaces auto-heal
        // via init.lua's repo_trust=="allow" retry path, even if the
        // worktree wasn't created yet when we fanned out above.
        await setClaudettePluginRepoSetting(
          data.repo_id,
          pluginName,
          "repo_trust",
          "allow",
        );
        if (data.workspace_id !== null) {
          setRow(pluginName, {
            kind: "trusting",
            startedAt,
            phase: "reloading",
          });
          // Force the failing workspace to re-resolve so the spinner
          // clears and the user can immediately start a chat / terminal.
          await reloadEnv(
            envTargetFromWorkspace(data.workspace_id),
            pluginName,
          );
          try {
            await prepareWorkspaceEnvironment(data.workspace_id);
          } catch {
            // Non-trust failures after a successful trust still leave
            // the row green — the env panel will reflect any residual
            // error separately.
          }
        }
        setRow(pluginName, {
          kind: "trusting",
          startedAt,
          phase: "verifying",
        });
        // Verify the trust command actually unblocked the affected
        // scope. The backend now returns Ok(()) for trust-only
        // failures (they route through the event), so we can't infer
        // success from the resolve's return value. See
        // `verifyPluginCleared` — it picks the right target based on
        // whether we have a workspace.
        const verify = await verifyPluginCleared(
          data.workspace_id,
          data.repo_id,
          pluginName,
        );
        if (verify.ok) {
          setRow(pluginName, { kind: "trusted" });
        } else {
          setRow(pluginName, { kind: "failed", error: verify.error });
        }
      } catch (e) {
        setRow(pluginName, {
          kind: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [data, setRow],
  );

  const handleDisable = useCallback(
    async (pluginName: string) => {
      if (!data) return;
      const startedAt = Date.now();
      setRow(pluginName, { kind: "disabling", startedAt, phase: "running" });
      try {
        await setEnvProviderEnabled(
          envTargetFromRepo(data.repo_id),
          pluginName,
          false,
        );
        if (data.workspace_id !== null) {
          setRow(pluginName, {
            kind: "disabling",
            startedAt,
            phase: "reloading",
          });
          // Re-resolve the failing workspace to drop the failure
          // status now that the provider is gated out of the
          // dispatcher entirely.
          await reloadEnv(
            envTargetFromWorkspace(data.workspace_id),
            pluginName,
          );
          try {
            await prepareWorkspaceEnvironment(data.workspace_id);
          } catch {
            // Same rationale as the trust path — non-trust residue
            // surfaces in the env panel, not here.
          }
        }
        setRow(pluginName, {
          kind: "disabling",
          startedAt,
          phase: "verifying",
        });
        // Same verification as the trust path: confirm the provider
        // is actually gone from the trust-error set. For Disable,
        // success is normally cheap to detect (the dispatcher filters
        // out disabled plugins before resolve), but the check costs
        // nothing extra and keeps the two paths symmetric.
        const verify = await verifyPluginCleared(
          data.workspace_id,
          data.repo_id,
          pluginName,
        );
        if (verify.ok) {
          setRow(pluginName, { kind: "disabled" });
        } else {
          setRow(pluginName, { kind: "failed", error: verify.error });
        }
      } catch (e) {
        setRow(pluginName, {
          kind: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [data, setRow],
  );

  if (!data) return null;

  const repo = repositories.find((r) => r.id === data.repo_id);
  const repoLabel = repo?.name ?? data.repo_id.slice(0, 8);

  return (
    <Modal title={t("env_trust_title")} onClose={closeModal} wide>
      <p className={styles.intro}>{t("env_trust_intro")}</p>
      <div className={styles.repoLabel}>
        <span>{t("env_trust_repo_label")}:</span>
        <span className={styles.repoName}>{repoLabel}</span>
      </div>
      <div className={styles.rows}>
        {data.plugins.map((p) => {
          const state = rowStates[p.plugin_name] ?? { kind: "idle" };
          const display = PLUGIN_DISPLAY[p.plugin_name] ?? p.plugin_name;
          const command = PLUGIN_TRUST_COMMAND[p.plugin_name] ?? "trust";
          const isBusy = state.kind === "trusting" || state.kind === "disabling";
          const isResolved =
            state.kind === "trusted" || state.kind === "disabled";
          return (
            <div key={p.plugin_name} className={styles.row}>
              <div className={styles.rowHeader}>
                <span className={styles.pluginName}>{display}</span>
                {state.kind === "trusted" && (
                  <span
                    className={`${styles.statusPill} ${styles.statusTrusted}`}
                  >
                    {t("env_trust_action_trusted")}
                  </span>
                )}
                {state.kind === "disabled" && (
                  <span
                    className={`${styles.statusPill} ${styles.statusDisabled}`}
                  >
                    {t("env_trust_action_disabled")}
                  </span>
                )}
                {state.kind === "failed" && (
                  <span
                    className={`${styles.statusPill} ${styles.statusFailed}`}
                  >
                    {t("env_trust_action_failed")}
                  </span>
                )}
              </div>
              <p className={styles.summary}>
                {p.message || t("env_trust_action_failed")}
              </p>
              {p.config_path && (
                <p className={styles.configPath} title={p.config_path}>
                  {p.config_path}
                </p>
              )}
              <button
                type="button"
                className={styles.detailsToggle}
                onClick={() =>
                  setDetailsOpen((s) => ({
                    ...s,
                    [p.plugin_name]: !s[p.plugin_name],
                  }))
                }
                aria-expanded={!!detailsOpen[p.plugin_name]}
              >
                {detailsOpen[p.plugin_name]
                  ? t("env_trust_details_hide")
                  : t("env_trust_details_show")}
              </button>
              {detailsOpen[p.plugin_name] && (
                <pre className={styles.excerpt}>{p.error_excerpt}</pre>
              )}
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={shared.btnPrimary}
                  disabled={isBusy || isResolved}
                  onClick={() => void handleTrust(p.plugin_name)}
                >
                  {state.kind === "trusting"
                    ? t("env_trust_action_trusting_progress", {
                        seconds: formatElapsed(state.startedAt),
                      })
                    : // Settled rows hold the terminal "Trusted" label
                    // instead of falling back to "Trust" — otherwise
                    // the button flashes "Trusting…" → "Trust" → close
                    // in the 600ms before auto-close. Same for Disable.
                    state.kind === "trusted"
                    ? t("env_trust_action_trusted")
                    : t("env_trust_action_trust")}
                </button>
                <button
                  type="button"
                  className={shared.btn}
                  disabled={isBusy || isResolved}
                  onClick={() => void handleDisable(p.plugin_name)}
                >
                  {state.kind === "disabling"
                    ? t("env_trust_action_disabling_progress", {
                        seconds: formatElapsed(state.startedAt),
                      })
                    : state.kind === "disabled"
                      ? t("env_trust_action_disabled")
                      : t("env_trust_action_disable")}
                </button>
              </div>
              {isBusy ? (
                <>
                  {/* Replace the static "Runs `cmd` in every worktree"
                      hint with a live phase indicator while busy. Same
                      visual slot, so the row doesn't reflow. The hint
                      reverts back to the static text once the user
                      either retries (failed) or the row settles. */}
                  <p className={styles.hint} aria-live="polite">
                    {phaseLabel(state.phase, command)}
                  </p>
                  {Date.now() - state.startedAt > 10_000 && (
                    <p className={styles.hint}>
                      {t("env_trust_progress_long_running")}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {/* Two hints, one per action — without the disable
                      hint the user has to infer that "Disable for
                      project" sets a per-repo flag (not just dismisses
                      the prompt). Copilot caught the unused locale
                      key on the first review pass. */}
                  <p className={styles.hint}>
                    {t("env_trust_trust_hint", { command })}
                  </p>
                  <p className={styles.hint}>
                    {t("env_trust_disable_hint")}
                  </p>
                </>
              )}
              {state.kind === "failed" && (
                <p className={styles.error}>{state.error}</p>
              )}
            </div>
          );
        })}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {/* "Decide later" is intentional — once a row settles the
              button flips to "Close" via env_trust_done. We use the
              dedicated env_trust_cancel key (not the generic common
              "Cancel") because the docstring + i18n contract describe
              this as a defer, not a cancellation. */}
          {Object.values(rowStates).some(
            (s) => s.kind === "trusted" || s.kind === "disabled",
          )
            ? t("env_trust_done")
            : t("env_trust_cancel")}
        </button>
      </div>
    </Modal>
  );
}
