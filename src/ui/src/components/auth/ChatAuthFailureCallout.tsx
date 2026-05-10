import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { cleanClaudeAuthError } from "./claudeAuth";
import styles from "./ChatAuthFailureCallout.module.css";

export function ChatAuthFailureCallout({ error }: { error: string }) {
  const { t } = useTranslation("settings");
  const openSettings = useAppStore((s) => s.openSettings);

  return (
    <div className={styles.callout}>
      <div className={styles.icon} aria-hidden="true">
        <KeyRound size={14} />
      </div>
      <div className={styles.body}>
        <div className={styles.title}>{t("auth_chat_failure_title")}</div>
        <div className={styles.description}>{t("auth_chat_failure_desc")}</div>
        <div className={styles.error}>{cleanClaudeAuthError(error)}</div>
        <button
          className={styles.action}
          onClick={() => openSettings("general")}
        >
          {t("auth_open_settings")}
        </button>
      </div>
    </div>
  );
}
