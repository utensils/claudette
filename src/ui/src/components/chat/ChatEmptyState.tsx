import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useEnvElapsedSeconds } from "../../hooks/useEnvElapsedSeconds";
import { formatEnvProviderName } from "../../utils/workspaceEnvironment";
import styles from "./ChatPanel.module.css";

interface ChatEmptyStateProps {
  workspaceEnvironmentPreparing: boolean;
  workspaceId: string | null;
  onRetryEnvironment?: () => void;
}

export function ChatEmptyState({
  workspaceEnvironmentPreparing,
  workspaceId,
  onRetryEnvironment,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");
  const { plugin: envPlugin, seconds: envSeconds } = useEnvElapsedSeconds(
    workspaceEnvironmentPreparing ? workspaceId : null,
  );

  if (!workspaceEnvironmentPreparing) {
    return <div className={styles.empty}>{t("send_message_to_start")}</div>;
  }

  const providerName = envPlugin ? formatEnvProviderName(envPlugin) : null;
  const title =
    providerName && envSeconds !== null
      ? t("empty_preparing_env_with_plugin", {
          plugin: providerName,
          seconds: envSeconds,
        })
      : t("empty_preparing_env");
  const ariaTitle = providerName
    ? t("empty_preparing_env_with_plugin_static", {
        plugin: providerName,
      })
    : t("empty_preparing_env");

  return (
    <div
      className={`${styles.empty} ${styles.emptyPreparing}`}
      role="status"
      aria-live="polite"
      aria-label={ariaTitle}
    >
      <LoaderCircle size={20} className={styles.emptySpinner} />
      <div className={styles.emptyTitle} aria-hidden="true">
        {title}
      </div>
      <div className={styles.emptySub}>{t("empty_preparing_env_subtitle")}</div>
      {onRetryEnvironment && (
        <button
          type="button"
          className={styles.emptyRetry}
          onClick={onRetryEnvironment}
        >
          {t("retry_environment", "Retry environment setup")}
        </button>
      )}
    </div>
  );
}
