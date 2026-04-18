import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Heatmap } from "../primitives/Heatmap";

export function SessionHeatmap() {
  const cells = useAppStore((s) => s.analyticsMetrics?.heatmap ?? []);
  const hasData = cells.some((c) => c.count > 0);

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>Activity · last 13 wk</span>
      {hasData ? (
        <Heatmap cells={cells} />
      ) : (
        <div className={styles.empty}>no data yet</div>
      )}
    </div>
  );
}
