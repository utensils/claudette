import { useTranslation } from "react-i18next";
import { ClaudeCodeAuthPanel } from "../../auth/ClaudeCodeAuthPanel";
import styles from "../Settings.module.css";

export function AuthenticationSettings() {
  const { t } = useTranslation("settings");

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("auth_title")}</h2>
      <p className={styles.sectionDescription}>{t("auth_desc")}</p>
      <ClaudeCodeAuthPanel />
      <div className={styles.authNotes}>
        <div>{t("auth_agent_note")}</div>
        <div>{t("auth_sign_out_note")}</div>
      </div>
    </div>
  );
}
