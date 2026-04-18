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
        return (
          <div key={i} className={styles.histRow}>
            <span className={styles.rowMuted}>{labels[i] ?? ""}</span>
            <div
              style={{
                position: "relative",
                height: 10,
                background: "var(--divider)",
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "var(--accent-primary)",
                  borderRadius: 2,
                  opacity: count === 0 ? 0.15 : 0.9,
                  transition: "width 400ms ease-out",
                }}
              />
            </div>
            <span className={styles.rowValue}>{count}</span>
          </div>
        );
      })}
    </div>
  );
}
