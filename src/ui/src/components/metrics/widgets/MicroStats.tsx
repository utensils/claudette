import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";

interface MicroStatsProps {
  workspaceId: string;
}

function formatShort(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

export function MicroStats({ workspaceId }: MicroStatsProps) {
  const stats = useAppStore((s) => s.workspaceMetrics[workspaceId]);
  if (!stats) return null;
  const { commitsCount, additions, deletions, latestSessionTurns } = stats;
  if (
    commitsCount === 0 &&
    additions === 0 &&
    deletions === 0 &&
    latestSessionTurns === 0
  ) {
    return null;
  }
  const parts: React.ReactNode[] = [];
  if (additions > 0 || deletions > 0) {
    parts.push(
      <span key="churn">
        <span className={styles.microAdd}>+{formatShort(additions)}</span>
        <span className={styles.microSep}>/</span>
        <span className={styles.microDel}>-{formatShort(deletions)}</span>
      </span>
    );
  }
  if (commitsCount > 0) {
    parts.push(<span key="commits">{commitsCount}c</span>);
  }
  if (latestSessionTurns > 0) {
    parts.push(<span key="turns">{latestSessionTurns}t</span>);
  }
  return (
    <div className={styles.microChip}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: "inline-flex", gap: 6 }}>
          {p}
          {i < parts.length - 1 ? (
            <span className={styles.microSep}>·</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
