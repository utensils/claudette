import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AUTH_SETTINGS_FOCUS,
  cleanClaudeAuthError,
  isClaudeAuthError,
  useClaudeAuthLogin,
} from "./claudeAuth";
import { ClaudeAuthCodeForm } from "./ClaudeAuthCodeForm";
import { getClaudeAuthStatus, type ClaudeAuthStatus } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import styles from "../settings/Settings.module.css";

type AuthStatusCheck =
  | { status: "checking" }
  | { status: "ready"; value: ClaudeAuthStatus }
  | { status: "error"; error: string };

export function ClaudeCodeAuthSetting() {
  const { t } = useTranslation("settings");
  const settingsFocus = useAppStore((s) => s.settingsFocus);
  const clearSettingsFocus = useAppStore((s) => s.clearSettingsFocus);
  const claudeAuthFailure = useAppStore((s) => s.claudeAuthFailure);
  const setClaudeAuthFailure = useAppStore((s) => s.setClaudeAuthFailure);
  const setResolvedClaudeAuthFailureMessageId = useAppStore(
    (s) => s.setResolvedClaudeAuthFailureMessageId,
  );
  const claudeAuthFailureMessageId = claudeAuthFailure?.messageId ?? null;
  const rowRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [statusCheck, setStatusCheck] = useState<AuthStatusCheck>({
    status: "checking",
  });

  const markAuthRecovered = useCallback(() => {
    if (claudeAuthFailureMessageId) {
      setResolvedClaudeAuthFailureMessageId(claudeAuthFailureMessageId);
    }
    setClaudeAuthFailure(null);
  }, [
    claudeAuthFailureMessageId,
    setClaudeAuthFailure,
    setResolvedClaudeAuthFailureMessageId,
  ]);

  const refreshStatus = useCallback(
    async (validate = false): Promise<ClaudeAuthStatus | null> => {
      setStatusCheck({ status: "checking" });
      try {
        const value = await getClaudeAuthStatus(validate);
        if (value.state === "signed_in" && value.verified) {
          markAuthRecovered();
        } else if (
          validate &&
          value.message &&
          (value.state === "signed_out" || isClaudeAuthError(value.message))
        ) {
          if (claudeAuthFailureMessageId) {
            setResolvedClaudeAuthFailureMessageId(null);
          }
          setClaudeAuthFailure({
            messageId: claudeAuthFailureMessageId,
            error: value.message,
          });
        }
        setStatusCheck({ status: "ready", value });
        return value;
      } catch (e) {
        setStatusCheck({ status: "error", error: String(e) });
        return null;
      }
    },
    [
      claudeAuthFailureMessageId,
      markAuthRecovered,
      setClaudeAuthFailure,
      setResolvedClaudeAuthFailureMessageId,
    ],
  );

  const { authState, startAuthLogin, cancelAuthLogin, submitAuthCode } =
    useClaudeAuthLogin({
      onSuccess: async () => {
        const value = await refreshStatus(true);
        if (value?.state !== "signed_in" || !value.verified) {
          throw new Error(
            value?.message ?? "Claude Code sign-in could not be verified.",
          );
        }
      },
    });

  const renderAuthCodeForm = () => {
    if (authState.status !== "running" || !authState.manualUrl) {
      return null;
    }
    return <ClaudeAuthCodeForm onSubmit={submitAuthCode} />;
  };

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (settingsFocus !== AUTH_SETTINGS_FOCUS) return;
    const frame = requestAnimationFrame(() => {
      rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      setIsFocused(true);
      clearSettingsFocus();
    });
    const timer = window.setTimeout(() => setIsFocused(false), 2400);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [clearSettingsFocus, settingsFocus]);

  const renderStatus = () => {
    if (authState.status === "running") {
      return (
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
          {renderAuthCodeForm()}
        </div>
      );
    }
    if (authState.status === "success") {
      return <div className={styles.authInlineSuccess}>{t("auth_success")}</div>;
    }
    if (authState.status === "error") {
      return (
        <div className={styles.authInlineError}>
          {cleanClaudeAuthError(authState.error)}
        </div>
      );
    }
    if (claudeAuthFailure) {
      return (
        <div className={styles.authInlineError}>
          {t("auth_status_last_failure")}{" "}
          {cleanClaudeAuthError(claudeAuthFailure.error)}
        </div>
      );
    }
    if (statusCheck.status === "checking") {
      return (
        <div className={styles.authInlineStatus}>
          {t("auth_status_checking")}
        </div>
      );
    }
    if (statusCheck.status === "error") {
      return (
        <div className={styles.authInlineError}>
          {cleanClaudeAuthError(statusCheck.error)}
        </div>
      );
    }
    if (statusCheck.value.state === "signed_in") {
      return (
        <div className={styles.authInlineSuccess}>
          {statusCheck.value.verified
            ? t("auth_status_verified")
            : t("auth_status_signed_in")}
        </div>
      );
    }
    if (statusCheck.value.state === "signed_out") {
      return (
        <div className={styles.authInlineError}>
          {statusCheck.value.message
            ? cleanClaudeAuthError(statusCheck.value.message)
            : t("auth_status_signed_out")}
        </div>
      );
    }
    return (
      <div className={styles.authInlineStatus}>
        {statusCheck.value.message
          ? cleanClaudeAuthError(statusCheck.value.message)
          : t("auth_status_unknown")}
      </div>
    );
  };

  return (
    <div
      ref={rowRef}
      className={`${styles.settingRow} ${isFocused ? styles.authFocusRow : ""}`}
    >
      <div className={styles.settingInfo}>
        <div className={styles.settingLabel}>{t("auth_setting_label")}</div>
        <div className={styles.settingDescription}>
          {t("auth_setting_desc")}
        </div>
        {renderStatus()}
      </div>
      <div className={styles.settingControl}>
        {authState.status === "running" ? (
          <button className={styles.iconBtn} onClick={cancelAuthLogin}>
            <X size={12} /> {t("auth_cancel")}
          </button>
        ) : (
          <div className={styles.inlineControl}>
            <button
              className={styles.iconBtn}
              onClick={() => void refreshStatus(true)}
              disabled={statusCheck.status === "checking"}
              title={t("auth_refresh_status")}
              aria-label={t("auth_refresh_status")}
            >
              <RefreshCw size={12} />
            </button>
            <button
              className={styles.iconBtn}
              onClick={() => {
                void startAuthLogin();
              }}
            >
              <LogIn size={12} />{" "}
              {statusCheck.status === "ready" && statusCheck.value.state === "signed_in"
                ? t("auth_reauthenticate")
                : t("auth_sign_in")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
