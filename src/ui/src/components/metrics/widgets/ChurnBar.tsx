import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { HBar } from "../primitives/HBar";

function format(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return n.toString();
}

export function ChurnBar() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const adds = metrics?.additions7d ?? 0;
  const dels = metrics?.deletions7d ?? 0;

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>Churn · 7d</span>
      <div className={styles.tileRow}>
        <span
          className={styles.tileValue}
          style={{ color: "var(--accent-primary)" }}
        >
          +{format(adds)}
        </span>
        <span
          className={styles.tileValue}
          style={{ color: "rgb(200, 110, 110)" }}
        >
          −{format(dels)}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>
        <HBar additions={adds} deletions={dels} />
      </div>
    </div>
  );
}
