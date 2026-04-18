import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Sparkline } from "../primitives/Sparkline";

export function CommitsSparkline() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const today = metrics?.commitsToday ?? 0;
  const series = metrics?.commitsDaily14d ?? [];

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>Commits · 14d</span>
      <div className={styles.tileRow}>
        <div className={styles.tileValue}>{today}</div>
        <div style={{ flex: 1, marginLeft: 10 }}>
          <Sparkline values={series} title="commits per day (14d)" />
        </div>
      </div>
      <div className={styles.tileSub}>today</div>
    </div>
  );
}
