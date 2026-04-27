import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import styles from "../Settings.module.css";

export function ExperimentalSettings() {
  const { t } = useTranslation("settings");
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const setPluginManagementEnabled = useAppStore((s) => s.setPluginManagementEnabled);
  const [error, setError] = useState<string | null>(null);

  const handleUsageToggle = async () => {
    const next = !usageInsightsEnabled;
    setUsageInsightsEnabled(next);
    try {
      setError(null);
      await setAppSetting("usage_insights_enabled", next ? "true" : "false");
    } catch (e) {
      setUsageInsightsEnabled(!next);
      setError(String(e));
    }
  };

  const handlePluginManagementToggle = async () => {
    const next = !pluginManagementEnabled;
    setPluginManagementEnabled(next);
    try {
      setError(null);
      await setAppSetting("plugin_management_enabled", next ? "true" : "false");
    } catch (e) {
      setPluginManagementEnabled(!next);
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("experimental_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("experimental_plugin_mgmt")}</div>
          <div className={styles.settingDescription}>
            {t("experimental_plugin_mgmt_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={pluginManagementEnabled}
            aria-label={t("experimental_plugin_mgmt_aria")}
            data-checked={pluginManagementEnabled}
            onClick={handlePluginManagementToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("experimental_usage")}</div>
          <div className={styles.settingDescription}>
            {t("experimental_usage_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={usageInsightsEnabled}
            aria-label={t("experimental_usage_aria")}
            data-checked={usageInsightsEnabled}
            onClick={handleUsageToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>
    </div>
  );
}
