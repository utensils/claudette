import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Folder, Copy } from "lucide-react";
import {
  setFrontendLogVerbosity,
  type FrontendLogVerbosity,
} from "../../../utils/log";
import styles from "../Settings.module.css";

// Mirrors the Rust `DiagnosticsSettings` struct in
// src-tauri/src/commands/diagnostics.rs. Optional strings stay
// `null`-able so the panel can render the "(default)" affordance.
interface DiagnosticsSettingsPayload {
  log_level: string | null;
  frontend_verbosity: string | null;
  log_dir: string | null;
  rust_log_active: boolean;
}

// EnvFilter directives the select offers. Anything more exotic (e.g.
// per-target overrides) belongs in the RUST_LOG path — the select is
// for users who don't want to know what an EnvFilter is.
const LOG_LEVELS = [
  { value: "", label: "default" },
  { value: "warn", label: "warn" },
  { value: "info", label: "info" },
  { value: "debug", label: "debug" },
  { value: "trace", label: "trace" },
] as const;

// Frontend verbosity values are inlined in the JSX below rather than
// pulled from a const list — i18next's typed-key checker can only
// resolve `t(...)` calls when the key is a string literal at the
// call site.

export function DiagnosticsSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<DiagnosticsSettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  // Pending "Copied!" hide-timer. Held in a ref so we can clear it on
  // unmount (or on a second click that re-arms the timer) without
  // letting the previous setTimeout flip `copied` on a torn-down tree.
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    invoke<DiagnosticsSettingsPayload>("get_diagnostics_settings")
      .then(setSettings)
      .catch((e) => setError(String(e)));
    // On unmount, cancel any in-flight `Copied!` reset so React
    // doesn't see a `setCopied(false)` on a stale component.
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  const updateLogLevel = async (value: string) => {
    if (pending) return;
    const previous = settings;
    setSettings((prev) => (prev ? { ...prev, log_level: value || null } : prev));
    setPending(true);
    setError(null);
    try {
      await invoke("set_log_level", { level: value });
    } catch (e) {
      setSettings(previous);
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  const updateFrontendVerbosity = async (value: FrontendLogVerbosity) => {
    if (pending) return;
    const previous = settings;
    setSettings((prev) =>
      prev ? { ...prev, frontend_verbosity: value } : prev,
    );
    setPending(true);
    setError(null);
    try {
      await invoke("set_frontend_verbosity", { verbosity: value });
      // Apply the change live — no restart needed for the bridge,
      // unlike the EnvFilter override above.
      setFrontendLogVerbosity(value);
    } catch (e) {
      setSettings(previous);
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  const openLogDir = async () => {
    setError(null);
    try {
      await invoke("open_log_dir");
    } catch (e) {
      setError(String(e));
    }
  };

  const copyLogPath = async () => {
    if (!settings?.log_dir) return;
    try {
      await writeText(settings.log_dir);
      setCopied(true);
      // Clear any prior pending reset so a rapid second click extends
      // the affordance instead of two timers racing. The cleanup in
      // the boot effect cancels whatever survives an unmount.
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch (e) {
      setError(String(e));
    }
  };

  const currentLevel = settings?.log_level ?? "";
  // Validate the persisted verbosity against the known set rather than
  // blind-casting from `string | null`. If the DB ever holds an
  // unrecognized value (manual edit, bad migration, future schema
  // change), the `<select>` would otherwise receive an invalid `value`
  // and the next `onChange` would round-trip the unknown string back
  // to the backend. Mirrors the same guard `main.tsx` uses when
  // priming the bridge from `get_diagnostics_settings`.
  const currentVerbosity: FrontendLogVerbosity =
    settings?.frontend_verbosity === "errors"
    || settings?.frontend_verbosity === "warnings"
    || settings?.frontend_verbosity === "all"
      ? settings.frontend_verbosity
      : "errors";

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("diagnostics_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      {/* Log level — restart required */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("diagnostics_log_level_label")}
          </div>
          <div className={styles.settingDescription}>
            {settings?.rust_log_active
              ? t("diagnostics_log_level_locked_by_rust_log")
              : t("diagnostics_log_level_description")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            value={currentLevel}
            onChange={(e) => void updateLogLevel(e.target.value)}
            disabled={pending || settings?.rust_log_active === true}
            className={styles.select}
          >
            {LOG_LEVELS.map((opt) => (
              <option key={opt.value || "default"} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Frontend bridge verbosity — live, no restart */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("diagnostics_frontend_verbosity_label")}
          </div>
          <div className={styles.settingDescription}>
            {t("diagnostics_frontend_verbosity_description")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            value={currentVerbosity}
            onChange={(e) =>
              void updateFrontendVerbosity(e.target.value as FrontendLogVerbosity)
            }
            disabled={pending}
            className={styles.select}
          >
            <option value="errors">
              {t("diagnostics_frontend_verbosity_errors")}
            </option>
            <option value="warnings">
              {t("diagnostics_frontend_verbosity_warnings")}
            </option>
            <option value="all">
              {t("diagnostics_frontend_verbosity_all")}
            </option>
          </select>
        </div>
      </div>

      {/* Log path actions */}
      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("diagnostics_log_dir_label")}
          </div>
          <div className={styles.settingDescription}>
            {settings?.log_dir ?? t("diagnostics_log_dir_unavailable")}
          </div>
        </div>
        <div className={styles.settingControl}>
          {/* Two iconBtns side-by-side need the project's standard
           * `inlineControl` flex+gap wrapper — same pattern Cli /
           * AgentBackends settings use when a row has multiple
           * adjacent buttons. Without it the two buttons sit flush
           * against each other. */}
          <div className={styles.inlineControl}>
            <button
              className={styles.iconBtn}
              onClick={openLogDir}
              disabled={!settings?.log_dir}
            >
              <Folder size={14} />
              {t("diagnostics_open_log_dir")}
            </button>
            <button
              className={styles.iconBtn}
              onClick={copyLogPath}
              disabled={!settings?.log_dir}
            >
              <Copy size={14} />
              {copied
                ? t("diagnostics_copy_log_path_copied")
                : t("diagnostics_copy_log_path")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
