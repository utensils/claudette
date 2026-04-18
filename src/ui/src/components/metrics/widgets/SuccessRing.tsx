import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Ring } from "../primitives/Ring";

export function SuccessRing() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const rate = metrics?.successRate30d ?? 0;

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>Success · 30d</span>
      <div className={styles.tileRow} style={{ marginTop: 4 }}>
        <Ring value={rate} />
        <div className={styles.tileSub} style={{ flex: 1 }}>
          completed sessions
        </div>
      </div>
    </div>
  );
}
