import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";

export function ParallelAgents() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const active = metrics?.activeSessions ?? 0;
  const today = metrics?.sessionsToday ?? 0;

  return (
    <div className={`${styles.tile} ${active > 0 ? styles.pulseGlow : ""}`}>
      <span className={styles.tileLabel}>Active agents</span>
      <div>
        <div className={`${styles.tileValue} ${styles.tileValueAccent}`}>
          {active}
        </div>
        <div className={styles.tileSub}>{today} sessions today</div>
      </div>
    </div>
  );
}
