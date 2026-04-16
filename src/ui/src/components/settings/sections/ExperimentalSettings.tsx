import { useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import styles from "../Settings.module.css";

export function ExperimentalSettings() {
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
      <h2 className={styles.sectionTitle}>Experimental</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Plugin Management</div>
          <div className={styles.settingDescription}>
            Show the Plugins settings section and enable the built-in
            plugin-management slash commands that open it.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={pluginManagementEnabled}
            aria-label="Plugin Management"
            data-checked={pluginManagementEnabled}
            onClick={handlePluginManagementToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Usage Insights</div>
          <div className={styles.settingDescription}>
            Show usage data from your Claude Code subscription (session limits,
            weekly limits, extra usage). Requires a Pro or Max plan with
            standard login.
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={usageInsightsEnabled}
            aria-label="Usage Insights"
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
