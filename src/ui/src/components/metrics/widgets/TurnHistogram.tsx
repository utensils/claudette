import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Histogram } from "../primitives/Histogram";

const LABELS = ["≤2", "≤4", "≤8", "≤16", "≤32", "≤64", "≤128", "129+"];

export function TurnHistogram() {
  const buckets = useAppStore(
    (s) => s.analyticsMetrics?.turnHistogram ?? []
  );
  const hasData = buckets.some((b) => b > 0);
  const padded = buckets.length === 8 ? buckets : new Array(8).fill(0);

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>Turns per session</span>
      {hasData ? (
        <Histogram buckets={padded} labels={LABELS} />
      ) : (
        <div className={styles.empty}>no data yet</div>
      )}
    </div>
  );
}
