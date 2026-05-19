import { KeyRound, LogIn, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  type AuthErrorProvider,
  type ClaudeAuthLoginController,
  cleanClaudeAuthError,
  cleanCodexAuthError,
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
  provider = "claude",
}: {
  controller: ClaudeAuthLoginController;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  showDescription?: boolean;
  /** Which agent backend's sign-in flow this panel is rendering. Drives
   *  the title, description, and the "manual auth code" form (only the
   *  Claude CLI supports paste-back; Codex's `codex login` is browser-
   *  only). Same chrome, branded per provider. */
  provider?: AuthErrorProvider;
}) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const { authState, startAuthLogin, cancelAuthLogin, submitAuthCode } =
    controller;
  const cleanError =
    provider === "codex" ? cleanCodexAuthError : cleanClaudeAuthError;
  const displayError = error ? cleanError(error) : null;
  const titleKey =
    provider === "codex" ? "auth_panel_title_codex" : "auth_panel_title";
  const descKey =
    provider === "codex" ? "auth_panel_desc_codex" : "auth_panel_desc";
  const signingInKey =
    provider === "codex" ? "auth_signing_in_codex" : "auth_signing_in";
  const signingInHintKey =
    provider === "codex" ? "auth_signing_in_hint_codex" : "auth_signing_in_hint";

  return (
    <div className={styles.authPanel}>
      <div className={styles.authPanelHeader}>
        <KeyRound size={18} />
        <div>
          <div className={styles.authPanelTitle}>{t(titleKey)}</div>
          {showDescription && (
            <div className={styles.authPanelDescription}>{t(descKey)}</div>
          )}
        </div>
      </div>

      {displayError && (
        <div className={styles.authPanelError}>{displayError}</div>
      )}

      {authState.status === "running" && (
        <div className={styles.authPanelStatus}>
          <span>{t(signingInKey)}</span>
          <span className={styles.usageTimestamp}>{t(signingInHintKey)}</span>
          {/* Manual-URL + paste-back code form are Claude-CLI-specific.
              The Codex CLI's `codex login` runs an unattended browser
              flow with no progress events, so neither bit applies — the
              controller's manualUrl stays null for Codex. */}
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
          {cleanError(authState.error)}
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
