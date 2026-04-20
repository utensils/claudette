import type { CSSProperties } from "react";
import styles from "../metrics.module.css";

interface HistogramProps {
  buckets: number[];
  labels: string[];
}

export function Histogram({ buckets, labels }: HistogramProps) {
  const max = Math.max(1, ...buckets);
  return (
    <div>
      {buckets.map((count, i) => {
        const pct = (count / max) * 100;
        const fillClass = `${styles.progressFill} ${count === 0 ? styles.progressFillFaint : ""}`;
        return (
          <div key={i} className={styles.histRow}>
            <span className={styles.rowMuted}>{labels[i] ?? ""}</span>
            <div className={`${styles.progressTrack} ${styles.progressTrackThick}`}>
              <div
                className={fillClass}
                style={{ "--p": `${pct}%` } as CSSProperties}
              />
            </div>
            <span className={styles.rowValue}>{count}</span>
          </div>
        );
      })}
    </div>
  );
}
