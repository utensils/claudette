import styles from "../metrics.module.css";

interface HBarProps {
  additions: number;
  deletions: number;
  width?: number;
  height?: number;
}

export function HBar({
  additions,
  deletions,
  width = 100,
  height = 8,
}: HBarProps) {
  const total = additions + deletions;
  if (total === 0) {
    return (
      <svg
        className={styles.svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="churn"
      >
        <rect
          className={styles.barTrack}
          x={0}
          y={0}
          width={width}
          height={height}
          rx={height / 2}
        />
      </svg>
    );
  }
  const addW = (additions / total) * width;
  const delW = width - addW;
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`+${additions} / -${deletions}`}
    >
      <rect
        className={styles.bar}
        x={0}
        y={0}
        width={addW}
        height={height}
        rx={height / 2}
      />
      <rect
        className={styles.barMuted}
        x={addW}
        y={0}
        width={delW}
        height={height}
        rx={height / 2}
      />
    </svg>
  );
}
