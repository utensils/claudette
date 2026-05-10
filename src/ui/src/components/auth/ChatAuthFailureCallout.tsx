import { LogIn } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { cleanClaudeAuthError } from "./claudeAuth";
import styles from "../settings/Settings.module.css";

export function ChatAuthFailureCallout({ error }: { error: string }) {
  const { t } = useTranslation("settings");
  const openSettings = useAppStore((s) => s.openSettings);

  return (
    <div className={styles.authPanel}>
      <div>
        <div className={styles.authPanelTitle}>
          {t("auth_chat_failure_title")}
        </div>
        <div className={styles.authPanelDescription}>
          {t("auth_chat_failure_desc")}
        </div>
      </div>
      <div className={styles.authPanelError}>{cleanClaudeAuthError(error)}</div>
      <div className={styles.usageActions}>
        <button
          className={`${styles.usageRefreshBtn} ${styles.usageRefreshBtnPrimary}`}
          onClick={() => openSettings("authentication")}
        >
          <LogIn size={12} /> {t("auth_sign_in")}
        </button>
      </div>
    </div>
  );
}
