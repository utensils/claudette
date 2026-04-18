import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Sparkline } from "../primitives/Sparkline";

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function CostCard() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const cost = metrics?.cost30dUsd ?? 0;
  const series = metrics?.costDaily30d ?? [];

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>Cost · 30d</span>
      <div className={styles.tileValue}>{formatUsd(cost)}</div>
      <div style={{ marginTop: 4 }}>
        <Sparkline values={series} title="daily cost (30d)" />
      </div>
    </div>
  );
}
