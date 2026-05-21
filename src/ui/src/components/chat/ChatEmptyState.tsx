import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatEnvProviderName } from "../../utils/workspaceEnvironment";
import styles from "./ChatPanel.module.css";

interface ChatEmptyStateProps {
  workspaceEnvironmentPreparing: boolean;
  envPlugin: string | null;
  envSeconds: number | null;
}

export function ChatEmptyState({
  workspaceEnvironmentPreparing,
  envPlugin,
  envSeconds,
}: ChatEmptyStateProps) {
  const { t } = useTranslation("chat");

  if (!workspaceEnvironmentPreparing) {
    return <div className={styles.empty}>{t("send_message_to_start")}</div>;
  }

  const title =
    envPlugin && envSeconds !== null
      ? t("empty_preparing_env_with_plugin", {
          plugin: formatEnvProviderName(envPlugin),
          seconds: envSeconds,
        })
      : t("empty_preparing_env");

  return (
    <div
      className={`${styles.empty} ${styles.emptyPreparing}`}
      role="status"
      aria-live="polite"
    >
      <LoaderCircle size={20} className={styles.emptySpinner} />
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptySub}>{t("empty_preparing_env_subtitle")}</div>
    </div>
  );
}
