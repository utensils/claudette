import styles from "../metrics.module.css";
import type { SessionDot } from "../../../types/metrics";

interface TimelineProps {
  dots: SessionDot[];
  onSelect?: (workspaceId: string) => void;
}

export function Timeline({ dots, onSelect }: TimelineProps) {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;

  if (dots.length === 0) {
    return <div className={styles.empty}>no sessions in last 24h</div>;
  }

  const width = 100;
  const height = 28;
  const r = 2.8;

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="24h session timeline"
      style={{ height: 32 }}
    >
      <line
        className={styles.axis}
        x1={0}
        x2={width}
        y1={height / 2}
        y2={height / 2}
      />
      {dots.map((dot, i) => {
        const t = Date.parse(dot.endedAt);
        const age = now - t;
        if (age < 0 || age > windowMs) return null;
        const x = width - (age / windowMs) * width;
        return (
          <circle
            key={`${dot.workspaceId}-${i}`}
            className={dot.completedOk ? styles.dotOk : styles.dotFail}
            cx={x}
            cy={height / 2}
            r={r}
            style={{ cursor: onSelect ? "pointer" : "default" }}
            onClick={() => onSelect?.(dot.workspaceId)}
          >
            <title>
              {new Date(t).toLocaleTimeString()} ·{" "}
              {dot.completedOk ? "ok" : "failed"}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
