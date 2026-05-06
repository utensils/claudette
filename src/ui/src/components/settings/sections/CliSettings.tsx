import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import styles from "../Settings.module.css";

interface CliStatus {
  bundledPath: string | null;
  targetPath: string;
  installedCurrent: boolean;
  installedStale: boolean;
  targetDirOnPath: boolean;
}

interface InstallResult {
  targetPath: string;
  targetDirOnPath: boolean;
  pathHint: string | null;
}

export function CliSettings() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathHint, setPathHint] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<InstallResult | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await invoke<CliStatus>("cli_status");
      setStatus(next);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    setBusy("install");
    setError(null);
    try {
      const result = await invoke<InstallResult>("install_cli_on_path");
      setLastResult(result);
      setPathHint(result.pathHint);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleUninstall = useCallback(async () => {
    setBusy("uninstall");
    setError(null);
    try {
      await invoke("uninstall_cli_from_path");
      setLastResult(null);
      setPathHint(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("cli_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("cli_install_label")}</div>
          <div className={styles.settingDescription}>
            {t("cli_install_description", { target: status?.targetPath ?? "…" })}
          </div>
        </div>
        <div className={styles.settingControl}>
          {status?.installedCurrent ? (
            <div className={styles.inlineControl}>
              <button
                className={styles.iconBtn}
                onClick={handleInstall}
                disabled={busy !== null}
              >
                {busy === "install" ? t("cli_reinstalling") : t("cli_reinstall")}
              </button>
              <button
                className={styles.iconBtn}
                onClick={handleUninstall}
                disabled={busy !== null}
              >
                {busy === "uninstall"
                  ? t("cli_uninstalling")
                  : t("cli_uninstall")}
              </button>
            </div>
          ) : status?.installedStale ? (
            <div className={styles.inlineControl}>
              <button
                className={styles.iconBtn}
                onClick={handleInstall}
                disabled={busy !== null || status?.bundledPath === null}
              >
                {busy === "install" ? t("cli_updating") : t("cli_update")}
              </button>
              <button
                className={styles.iconBtn}
                onClick={handleUninstall}
                disabled={busy !== null}
              >
                {busy === "uninstall"
                  ? t("cli_uninstalling")
                  : t("cli_uninstall")}
              </button>
            </div>
          ) : (
            <button
              className={styles.iconBtn}
              onClick={handleInstall}
              // status === null: cli_status hasn't resolved yet; don't
              // let the user click Install before we know whether the
              // bundled binary even exists.
              disabled={
                busy !== null || status === null || status.bundledPath === null
              }
              title={
                status?.bundledPath === null
                  ? t("cli_dev_build_warning")
                  : undefined
              }
            >
              {busy === "install" ? t("cli_installing") : t("cli_install")}
            </button>
          )}
        </div>
      </div>

      {status?.installedCurrent && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>{t("cli_status_label")}</div>
            <div className={styles.settingDescription}>
              {t("cli_status_installed", { target: status.targetPath })}
            </div>
          </div>
        </div>
      )}

      {status?.installedStale && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>{t("cli_status_label")}</div>
            <div className={styles.settingDescription}>
              {t("cli_status_stale", { target: status.targetPath })}
            </div>
          </div>
        </div>
      )}

      {status?.bundledPath === null && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingDescription}>
              {t("cli_dev_build_warning")}
            </div>
          </div>
        </div>
      )}

      {pathHint && lastResult && !lastResult.targetDirOnPath && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>{t("cli_path_hint_label")}</div>
            <pre className={styles.settingDescription} style={{ whiteSpace: "pre-wrap" }}>
              {pathHint}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
