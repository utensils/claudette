import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import { UsageInsightsConfirmModal } from "./UsageInsightsConfirmModal";
import { CLAUDE_CODE_USAGE_FOCUS } from "../focusKeys";
import styles from "../Settings.module.css";

// Re-export for legacy callers; new code should import from
// `../focusKeys` directly to keep settings imports out of the
// composer chunk.
export { CLAUDE_CODE_USAGE_FOCUS };

export function ExperimentalSettings() {
  const { t } = useTranslation("settings");
  const settingsFocus = useAppStore((s) => s.settingsFocus);
  const clearSettingsFocus = useAppStore((s) => s.clearSettingsFocus);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);
  const claudetteMcpEnabled = useAppStore((s) => s.claudetteMcpEnabled);
  const setClaudetteMcpEnabled = useAppStore((s) => s.setClaudetteMcpEnabled);
  const [error, setError] = useState<string | null>(null);
  const [usageConfirmOpen, setUsageConfirmOpen] = useState(false);
  const usageRowRef = useRef<HTMLDivElement>(null);
  const [usageRowFocused, setUsageRowFocused] = useState(false);

  // Deep-link from the composer's greyed-out usage indicator
  // (`openSettings("experimental", "claude-code-usage")`). Mirror
  // ClaudeCodeAuthSetting's pattern: scroll into view, apply the
  // shared `authFocusRow` highlight for a couple of seconds, then
  // clear the focus key so the highlight doesn't re-trigger.
  useEffect(() => {
    if (settingsFocus !== CLAUDE_CODE_USAGE_FOCUS) return;
    const frame = requestAnimationFrame(() => {
      usageRowRef.current?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      setUsageRowFocused(true);
      clearSettingsFocus();
    });
    const timer = window.setTimeout(() => setUsageRowFocused(false), 2400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [clearSettingsFocus, settingsFocus]);

  const applyUsageInsights = async (next: boolean) => {
    setUsageInsightsEnabled(next);
    try {
      setError(null);
      await setAppSetting("usage_insights_enabled", next ? "true" : "false");
    } catch (e) {
      setUsageInsightsEnabled(!next);
      setError(String(e));
    }
  };

  const handleUsageToggle = async () => {
    // Confirm only on OFF -> ON. Disabling never prompts.
    if (!usageInsightsEnabled) {
      setUsageConfirmOpen(true);
      return;
    }
    await applyUsageInsights(false);
  };

  const handleClaudetteMcpToggle = async () => {
    const next = !claudetteMcpEnabled;
    setClaudetteMcpEnabled(next);
    try {
      setError(null);
      await setAppSetting("claudette_mcp_enabled", next ? "true" : "false");
    } catch (e) {
      setClaudetteMcpEnabled(!next); // revert optimistic update on failure
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("experimental_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div
        ref={usageRowRef}
        className={`${styles.settingRow} ${usageRowFocused ? styles.authFocusRow : ""}`}
        id="claude-code-usage-setting"
      >
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>
            {t("experimental_claude_code_usage")}
          </div>
          <div className={styles.settingDescription}>
            {t("experimental_claude_code_usage_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={usageInsightsEnabled}
            aria-label={t("experimental_claude_code_usage_aria")}
            data-checked={usageInsightsEnabled}
            onClick={handleUsageToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      <div className={styles.settingRow} id="claudette-mcp-setting">
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("experimental_claudette_mcp")}</div>
          <div className={styles.settingDescription}>
            {t("experimental_claudette_mcp_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <button
            className={styles.toggle}
            role="switch"
            aria-checked={claudetteMcpEnabled}
            aria-label={t("experimental_claudette_mcp_aria")}
            data-checked={claudetteMcpEnabled}
            onClick={handleClaudetteMcpToggle}
          >
            <div className={styles.toggleKnob} />
          </button>
        </div>
      </div>

      {usageConfirmOpen && (
        <UsageInsightsConfirmModal
          onCancel={() => setUsageConfirmOpen(false)}
          onConfirm={() => {
            setUsageConfirmOpen(false);
            void applyUsageInsights(true);
          }}
        />
      )}
    </div>
  );
}
