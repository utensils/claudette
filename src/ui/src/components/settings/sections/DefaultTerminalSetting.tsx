import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import {
  deleteAppSetting,
  setAppSetting,
} from "../../../services/tauri";
import { AppIcon } from "../../chat/WorkspaceActions";
import type { DetectedApp } from "../../../types/apps";
import styles from "../Settings.module.css";

const DEFAULT_TERMINAL_APP_SETTING_KEY = "default_terminal_app_id";

export function terminalAppsFrom(apps: DetectedApp[]): DetectedApp[] {
  return apps.filter((app) => app.category === "terminal");
}

export function DefaultTerminalSetting() {
  const { t } = useTranslation("settings");
  const detectedApps = useAppStore((s) => s.detectedApps);
  const defaultTerminalAppId = useAppStore((s) => s.defaultTerminalAppId);
  const setDefaultTerminalAppId = useAppStore((s) => s.setDefaultTerminalAppId);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const terminalApps = useMemo(
    () => terminalAppsFrom(detectedApps),
    [detectedApps],
  );
  const selectedTerminal = terminalApps.find(
    (app) => app.id === defaultTerminalAppId,
  );
  const effectiveDefaultTerminalAppId = selectedTerminal
    ? defaultTerminalAppId
    : null;
  const selectedLabel =
    selectedTerminal?.name ?? t("workspace_apps_terminal_auto");

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  const chooseTerminal = async (appId: string | null) => {
    if (appId === defaultTerminalAppId) {
      setOpen(false);
      return;
    }

    const previous = defaultTerminalAppId;
    setDefaultTerminalAppId(appId);
    setOpen(false);
    setSaving(true);
    try {
      setError(null);
      if (appId === null) {
        await deleteAppSetting(DEFAULT_TERMINAL_APP_SETTING_KEY);
      } else {
        await setAppSetting(DEFAULT_TERMINAL_APP_SETTING_KEY, appId);
      }
    } catch (err) {
      setDefaultTerminalAppId(previous);
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("workspace_apps_default_terminal")}
          </div>
          <div className={styles.settingDescription}>
            {t("workspace_apps_default_terminal_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.appPicker} ref={pickerRef}>
            <button
              className={styles.appPickerButton}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label={t("workspace_apps_default_terminal")}
              disabled={saving}
              onClick={() => setOpen((value) => !value)}
            >
              {selectedTerminal ? (
                <AppIcon app={selectedTerminal} />
              ) : (
                <span className={styles.appPickerAutoIcon} aria-hidden="true">
                  <Terminal size={14} strokeWidth={2.2} />
                </span>
              )}
              <span className={styles.appPickerLabel}>{selectedLabel}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>

            {open && (
              <div
                className={styles.appPickerMenu}
                role="listbox"
                aria-label={t("workspace_apps_default_terminal")}
              >
                <button
                  className={
                    effectiveDefaultTerminalAppId === null
                      ? styles.appPickerOptionSelected
                      : styles.appPickerOption
                  }
                  type="button"
                  role="option"
                  aria-selected={effectiveDefaultTerminalAppId === null}
                  onClick={() => void chooseTerminal(null)}
                >
                  <span className={styles.appPickerAutoIcon} aria-hidden="true">
                    <Terminal size={14} strokeWidth={2.2} />
                  </span>
                  <span className={styles.appPickerOptionText}>
                    <span className={styles.appPickerOptionLabel}>
                      {t("workspace_apps_terminal_auto")}
                    </span>
                    <span className={styles.appPickerOptionHint}>
                      {t("workspace_apps_terminal_auto_desc")}
                    </span>
                  </span>
                  {effectiveDefaultTerminalAppId === null && <Check size={14} />}
                </button>

                {terminalApps.map((app) => (
                  <button
                    className={
                      effectiveDefaultTerminalAppId === app.id
                        ? styles.appPickerOptionSelected
                        : styles.appPickerOption
                    }
                    type="button"
                    role="option"
                    aria-selected={effectiveDefaultTerminalAppId === app.id}
                    key={app.id}
                    onClick={() => void chooseTerminal(app.id)}
                  >
                    <AppIcon app={app} />
                    <span className={styles.appPickerOptionText}>
                      <span className={styles.appPickerOptionLabel}>
                        {app.name}
                      </span>
                    </span>
                    {effectiveDefaultTerminalAppId === app.id && <Check size={14} />}
                  </button>
                ))}

                {terminalApps.length === 0 && (
                  <div className={styles.appPickerEmpty}>
                    {t("workspace_apps_no_terminals")}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
