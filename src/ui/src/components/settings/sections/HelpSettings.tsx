import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Keyboard, ExternalLink, FileText, Bug } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { openUrl } from "../../../services/tauri";
import {
  HELP_DOCS_URL,
  HELP_ISSUES_URL,
  HELP_RELEASE_URL_BASE,
  releaseTagFor,
} from "../../../helpUrls";
import styles from "../Settings.module.css";

export function HelpSettings() {
  const { t } = useTranslation("settings");
  const openModal = useAppStore((s) => s.openModal);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const openChangelog = () => {
    if (!appVersion) return;
    void openUrl(`${HELP_RELEASE_URL_BASE}${releaseTagFor(appVersion)}`).catch(
      () => {},
    );
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("help_title")}</h2>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("help_version_label")}</div>
          <div className={styles.settingDescription}>
            {appVersion ? `Claudette v${appVersion}` : "—"}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.iconBtn}
            onClick={openChangelog}
            disabled={!appVersion}
          >
            <ExternalLink size={14} />
            {t("help_view_changelog")}
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("help_shortcuts_label")}</div>
          <div className={styles.settingDescription}>
            {t("help_shortcuts_description")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.iconBtn}
            onClick={() => openModal("keyboard-shortcuts")}
          >
            <Keyboard size={14} />
            {t("help_shortcuts_button")}
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("help_docs_label")}</div>
          <div className={styles.settingDescription}>
            {t("help_docs_description")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.iconBtn}
            onClick={() => void openUrl(HELP_DOCS_URL).catch(() => {})}
          >
            <FileText size={14} />
            {t("help_docs_button")}
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("help_issues_label")}</div>
          <div className={styles.settingDescription}>
            {t("help_issues_description")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.iconBtn}
            onClick={() => void openUrl(HELP_ISSUES_URL).catch(() => {})}
          >
            <Bug size={14} />
            {t("help_issues_button")}
          </button>
        </div>
      </div>
    </div>
  );
}
