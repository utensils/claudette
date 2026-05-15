import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentBackendConfig,
  type AgentBackendRuntimeHarness,
  availableHarnessesForKind,
  defaultHarnessForKind,
  effectiveHarness,
  setAgentBackendRuntimeHarness,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./Settings.module.css";

interface RuntimeSelectorProps {
  backend: AgentBackendConfig;
  onSaved: (backends: AgentBackendConfig[]) => void;
  onError?: (err: unknown) => void;
}

function harnessLabelKey(harness: AgentBackendRuntimeHarness): string {
  switch (harness) {
    case "claude_code":
      return "models_backend_runtime_claude_cli_label";
    case "pi_sdk":
      return "models_backend_runtime_pi_label";
    case "codex_app_server":
      return "models_backend_runtime_codex_app_server_label";
  }
}

function harnessFallbackLabel(harness: AgentBackendRuntimeHarness): string {
  switch (harness) {
    case "claude_code":
      return "Claude CLI";
    case "pi_sdk":
      return "Pi";
    case "codex_app_server":
      return "Codex app-server";
  }
}

/**
 * Per-backend runtime picker. Only renders when the kind has more than
 * one valid harness — for Anthropic / Pi / Codex-Subscription cards the
 * matrix has a single entry so the selector silently no-ops.
 *
 * Server-side `set_agent_backend_runtime_harness` rejects values outside
 * `availableHarnessesForKind` as defense-in-depth; this UI mirrors that
 * matrix so the user never sees an option the resolver wouldn't accept.
 */
export function RuntimeSelector({ backend, onSaved, onError }: RuntimeSelectorProps) {
  const { t } = useTranslation("settings");
  const harnesses = useMemo(() => availableHarnessesForKind(backend.kind), [backend.kind]);
  const defaultHarness = defaultHarnessForKind(backend.kind);
  const current = effectiveHarness(backend);
  const piEnabled = useAppStore((s) =>
    s.agentBackends.some((b) => b.kind === "pi_sdk" && b.enabled),
  );
  const [busy, setBusy] = useState(false);

  if (harnesses.length <= 1) return null;

  async function onChange(next: AgentBackendRuntimeHarness) {
    setBusy(true);
    try {
      // Persist `null` (clear override) when the user picks the default,
      // so the row stays clean of redundant data and a future change to
      // the default-per-kind table picks them up automatically.
      const harnessArg = next === defaultHarness ? null : next;
      const saved = await setAgentBackendRuntimeHarness(backend.id, harnessArg);
      onSaved(saved);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className={styles.backendField}>
      <span className={styles.backendFieldLabel}>
        {t("models_backend_runtime_label", "Runtime")}
      </span>
      <select
        className={styles.select}
        value={current}
        disabled={busy}
        onChange={(e) => void onChange(e.target.value as AgentBackendRuntimeHarness)}
        aria-label={t("models_backend_runtime_label", "Runtime")}
      >
        {harnesses.map((harness) => {
          const isPi = harness === "pi_sdk";
          const piUnavailable = isPi && !piEnabled;
          const baseLabel = t(harnessLabelKey(harness), harnessFallbackLabel(harness));
          // The unavailable suffix wins over the default suffix:
          // "(default)" implies the user gets that runtime out of the
          // box, which is misleading when the option is actually
          // disabled because the Pi backend itself isn't enabled.
          const suffix = piUnavailable
            ? ` (${t("models_backend_runtime_pi_unavailable_suffix", "Pi disabled")})`
            : harness === defaultHarness
              ? ` (${t("models_backend_runtime_default_suffix", "default")})`
              : "";
          return (
            <option key={harness} value={harness} disabled={piUnavailable}>
              {baseLabel}
              {suffix}
            </option>
          );
        })}
      </select>
    </label>
  );
}
