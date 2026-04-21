import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { RepoIcon } from "../../shared/RepoIcon";
import { formatTokens } from "../../chat/formatTokens";

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function RepoLeaderboard() {
  const rows = useAppStore((s) => s.analyticsMetrics?.repoLeaderboard);
  const repositories = useAppStore((s) => s.repositories);
  const repoMap = new Map(repositories.map((r) => [r.id, r]));

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>Repo leaderboard</span>
      {!rows || rows.length === 0 ? (
        <div className={styles.empty}>no data yet</div>
      ) : (
        <div className={styles.rowList}>
          {rows.map((row) => {
            const repo = repoMap.get(row.repositoryId);
            const name = repo?.name ?? "unknown repo";
            const icon = repo?.icon;
            return (
              <div key={row.repositoryId} className={styles.leaderRow}>
                <span className={styles.rowLabel}>
                  {icon ? (
                    <RepoIcon icon={icon} size={12} className={styles.repoIcon} />
                  ) : null}
                  {name}
                </span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title="sessions">{row.sessions}s</span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title="commits">{row.commits}c</span>
                <span className={`${styles.rowMuted} ${styles.hideNarrow}`} title="tokens (in + out)">
                  {formatTokens(row.totalInputTokens + row.totalOutputTokens)}t
                </span>
                <span className={styles.rowValue} title="cost">
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
