import styles from "../metrics.module.css";

interface RingProps {
  /** Value in [0, 1]. */
  value: number;
  label?: string;
  size?: number;
  stroke?: number;
}

export function Ring({ value, label, size = 56, stroke = 5 }: RingProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - clamped);
  const displayLabel = label ?? `${Math.round(clamped * 100)}%`;

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${displayLabel} success`}
    >
      <circle
        className={styles.ringTrack}
        cx={cx}
        cy={cy}
        r={r}
        strokeWidth={stroke}
      />
      <circle
        className={styles.ringArc}
        cx={cx}
        cy={cy}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <text className={styles.ringCenter} x={cx} y={cy}>
        {displayLabel}
      </text>
    </svg>
  );
}
