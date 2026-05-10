import { LogIn, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cleanClaudeAuthError, useClaudeAuthLogin } from "./claudeAuth";
import styles from "../settings/Settings.module.css";

export function ClaudeCodeAuthSetting() {
  const { t } = useTranslation("settings");
  const { authState, startAuthLogin, cancelAuthLogin } = useClaudeAuthLogin();

  return (
    <div className={styles.settingRow}>
      <div className={styles.settingInfo}>
        <div className={styles.settingLabel}>{t("auth_setting_label")}</div>
        <div className={styles.settingDescription}>
          {t("auth_setting_desc")}
        </div>
        {authState.status === "running" && (
          <div className={styles.authInlineStatus}>
            {t("auth_signing_in_hint")}
            {authState.manualUrl && (
              <>
                {" "}
                <a
                  className={styles.usageManageLink}
                  href={authState.manualUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("auth_manual_url")}
                </a>
              </>
            )}
          </div>
        )}
        {authState.status === "success" && (
          <div className={styles.authInlineSuccess}>{t("auth_success")}</div>
        )}
        {authState.status === "error" && (
          <div className={styles.authInlineError}>
            {cleanClaudeAuthError(authState.error)}
          </div>
        )}
      </div>
      <div className={styles.settingControl}>
        {authState.status === "running" ? (
          <button className={styles.iconBtn} onClick={cancelAuthLogin}>
            <X size={12} /> {t("auth_cancel")}
          </button>
        ) : (
          <button className={styles.iconBtn} onClick={startAuthLogin}>
            <LogIn size={12} /> {t("auth_sign_in")}
          </button>
        )}
      </div>
    </div>
  );
}
