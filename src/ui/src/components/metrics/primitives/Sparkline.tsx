import styles from "../metrics.module.css";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  fill?: boolean;
  title?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 28,
  fill = true,
  title,
}: SparklineProps) {
  if (values.length === 0) {
    return <div className={styles.empty}>no data yet</div>;
  }

  const max = Math.max(1, ...values);
  const min = 0;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / (max - min || 1)) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? "sparkline"}
    >
      <line
        className={styles.axis}
        x1={0}
        x2={width}
        y1={height - 0.5}
        y2={height - 0.5}
      />
      {fill ? <polygon className={styles.markFill} points={areaPoints} /> : null}
      <polyline className={styles.mark} points={points} />
    </svg>
  );
}
