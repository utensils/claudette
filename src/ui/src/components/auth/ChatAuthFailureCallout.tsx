import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { AUTH_SETTINGS_FOCUS, cleanClaudeAuthError } from "./claudeAuth";
import styles from "./ChatAuthFailureCallout.module.css";

export function ChatAuthFailureCallout({
  error,
  messageId,
}: {
  error: string;
  messageId: string;
}) {
  const { t } = useTranslation("settings");
  const openSettings = useAppStore((s) => s.openSettings);
  const setClaudeAuthFailure = useAppStore((s) => s.setClaudeAuthFailure);

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
          type="button"
          className={styles.action}
          onClick={() => {
            setClaudeAuthFailure({ messageId, error });
            openSettings("general", AUTH_SETTINGS_FOCUS);
          }}
        >
          {t("auth_open_settings")}
        </button>
      </div>
    </div>
  );
}
