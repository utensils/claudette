import { KeyRound, LogIn, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type ClaudeAuthLoginController,
  cleanClaudeAuthError,
  useClaudeAuthLogin,
} from "./claudeAuth";
import { ClaudeAuthCodeForm } from "./ClaudeAuthCodeForm";
import styles from "../settings/Settings.module.css";

export function ClaudeCodeAuthPanel({
  error,
  onAuthenticated,
  onRetry,
  showDescription = true,
}: {
  error?: string | null;
  onAuthenticated?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  showDescription?: boolean;
}) {
  const controller = useClaudeAuthLogin({
    onSuccess: onAuthenticated,
  });

  return (
    <ClaudeCodeAuthPanelView
      controller={controller}
      error={error}
      onRetry={onRetry}
      showDescription={showDescription}
    />
  );
}

export function ClaudeCodeAuthPanelView({
  controller,
  error,
  onRetry,
  showDescription = true,
}: {
  controller: ClaudeAuthLoginController;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  showDescription?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const { authState, startAuthLogin, cancelAuthLogin, submitAuthCode } =
    controller;
  const displayError = error ? cleanClaudeAuthError(error) : null;

  return (
    <div className={styles.authPanel}>
      <div className={styles.authPanelHeader}>
        <KeyRound size={18} />
        <div>
          <div className={styles.authPanelTitle}>{t("auth_panel_title")}</div>
          {showDescription && (
            <div className={styles.authPanelDescription}>
              {t("auth_panel_desc")}
            </div>
          )}
        </div>
      </div>

      {displayError && (
        <div className={styles.authPanelError}>{displayError}</div>
      )}

      {authState.status === "running" && (
        <div className={styles.authPanelStatus}>
          <span>{t("auth_signing_in")}</span>
          <span className={styles.usageTimestamp}>
            {t("auth_signing_in_hint")}
          </span>
          {authState.manualUrl && (
            <a
              className={styles.usageManageLink}
              href={authState.manualUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("auth_manual_url")}
            </a>
          )}
          {authState.manualUrl && <ClaudeAuthCodeForm onSubmit={submitAuthCode} />}
        </div>
      )}

      {authState.status === "success" && (
        <div className={styles.authPanelSuccess}>{t("auth_success")}</div>
      )}

      {authState.status === "error" && (
        <div className={styles.authPanelError}>
          {cleanClaudeAuthError(authState.error)}
        </div>
      )}

      <div className={styles.usageActions}>
        {authState.status === "running" ? (
          <button className={styles.usageRefreshBtn} onClick={cancelAuthLogin}>
            <X size={12} /> {t("auth_cancel")}
          </button>
        ) : (
          <button
            className={`${styles.usageRefreshBtn} ${styles.usageRefreshBtnPrimary}`}
            onClick={startAuthLogin}
          >
            <LogIn size={12} /> {t("auth_sign_in")}
          </button>
        )}
        {onRetry && authState.status !== "running" && (
          <button
            className={styles.usageRefreshBtn}
            onClick={() => void onRetry()}
          >
            <RefreshCw size={12} /> {tCommon("retry")}
          </button>
        )}
      </div>
    </div>
  );
}
