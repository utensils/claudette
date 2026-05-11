import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { Modal } from "./Modal";
import {
  envTargetFromRepo,
  envTargetFromWorkspace,
  reloadEnv,
  runEnvTrust,
  setEnvProviderEnabled,
} from "../../services/env";
import { setClaudettePluginRepoSetting } from "../../services/claudettePlugins";
import { prepareWorkspaceEnvironment } from "../../services/tauri";
import shared from "./shared.module.css";
import styles from "./EnvTrustModal.module.css";

/**
 * Per-plugin row state — the modal can have several rows in flight at
 * once (mise AND direnv both untrusted on a fresh worktree is common).
 * Each transitions independently as the user clicks Trust / Disable.
 */
type RowState =
  | { kind: "idle" }
  | { kind: "trusting" }
  | { kind: "disabling" }
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
  workspace_id: string;
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

export function isEnvTrustModalData(value: unknown): value is EnvTrustModalData {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspace_id === "string" &&
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
  const { t: tCommon } = useTranslation("common");
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

  const handleTrust = useCallback(
    async (pluginName: string) => {
      if (!data) return;
      setRow(pluginName, { kind: "trusting" });
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
        // Force the failing workspace to re-resolve so the spinner
        // clears and the user can immediately start a chat / terminal.
        await reloadEnv(envTargetFromWorkspace(data.workspace_id), pluginName);
        try {
          await prepareWorkspaceEnvironment(data.workspace_id);
        } catch {
          // Non-trust failures after a successful trust still leave
          // the row green — the env panel will reflect any residual
          // error separately.
        }
        setRow(pluginName, { kind: "trusted" });
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
      setRow(pluginName, { kind: "disabling" });
      try {
        await setEnvProviderEnabled(
          envTargetFromRepo(data.repo_id),
          pluginName,
          false,
        );
        // Re-resolve to drop the failure status now that the provider
        // is gated out of the dispatcher entirely.
        await reloadEnv(envTargetFromWorkspace(data.workspace_id), pluginName);
        try {
          await prepareWorkspaceEnvironment(data.workspace_id);
        } catch {
          // Same rationale as the trust path — non-trust residue
          // surfaces in the env panel, not here.
        }
        setRow(pluginName, { kind: "disabled" });
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
                    ? t("env_trust_action_trusting")
                    : t("env_trust_action_trust")}
                </button>
                <button
                  type="button"
                  className={shared.btn}
                  disabled={isBusy || isResolved}
                  onClick={() => void handleDisable(p.plugin_name)}
                >
                  {state.kind === "disabling"
                    ? t("env_trust_action_disabling")
                    : t("env_trust_action_disable")}
                </button>
              </div>
              <p className={styles.hint}>
                {t("env_trust_trust_hint", { command })}
              </p>
              {state.kind === "failed" && (
                <p className={styles.error}>{state.error}</p>
              )}
            </div>
          );
        })}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {Object.values(rowStates).some(
            (s) => s.kind === "trusted" || s.kind === "disabled",
          )
            ? t("env_trust_done")
            : tCommon("cancel")}
        </button>
      </div>
    </Modal>
  );
}
