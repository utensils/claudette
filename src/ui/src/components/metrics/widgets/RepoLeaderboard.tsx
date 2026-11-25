import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { RepoIcon } from "../../shared/RepoIcon";
import { formatTokens } from "../../chat/formatTokens";

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function RepoLeaderboard() {
  const { t } = useTranslation();
  const rows = useAppStore((s) => s.analyticsMetrics?.repoLeaderboard);
  const repositories = useAppStore((s) => s.repositories);
  const repoMap = new Map(repositories.map((r) => [r.id, r]));

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>{t("metrics_leaderboard")}</span>
      {!rows || rows.length === 0 ? (
        <div className={styles.empty}>{t("metrics_no_data")}</div>
      ) : (
        <div className={styles.rowList}>
          {rows.map((row) => {
            const repo = repoMap.get(row.repositoryId);
            const name = repo?.name ?? t("metrics_unknown_repo");
            const icon = repo?.icon;
            return (
              <div key={row.repositoryId} className={styles.leaderRow}>
                <span className={styles.rowLabel}>
                  {icon ? (
                    <RepoIcon icon={icon} size={12} className={styles.repoIcon} />
                  ) : null}
                  {name}
                </span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title={t("metrics_sessions")}>{row.sessions}s</span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title={t("metrics_commits")}>{row.commits}c</span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title={t("metrics_tokens_in_out")}>
                  {formatTokens(row.totalInputTokens + row.totalOutputTokens)}t
                </span>
                <span className={styles.rowValue} title={t("metrics_cost")}>
                  {formatUsd(row.totalCostUsd)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
