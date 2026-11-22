import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import type { SessionDot } from "../../../types/metrics";

interface TimelineProps {
  dots: SessionDot[];
}

/**
 * Decorative visualization of session activity over the last 24 hours.
 * Workspace selection happens via the workspace cards, not the timeline —
 * keeping this read-only lets `role="img"` stay honest about assistive-tech
 * semantics (the SVG is a single figure, not a button list).
 */
export function Timeline({ dots }: TimelineProps) {
  const { t } = useTranslation();
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;

  if (dots.length === 0) {
    return <div className={styles.empty}>{t("metrics_timeline_empty")}</div>;
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
      aria-label={t("metrics_timeline_aria")}
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
        const endedAt = Date.parse(dot.endedAt);
        const age = now - endedAt;
        if (age < 0 || age > windowMs) return null;
        const x = width - (age / windowMs) * width;
        return (
          <circle
            key={`${dot.workspaceId}-${i}`}
            className={dot.completedOk ? styles.dotOk : styles.dotFail}
            cx={x}
            cy={height / 2}
            r={r}
          >
            <title>
              {new Date(endedAt).toLocaleTimeString()} ·{" "}
              {dot.completedOk ? t("metrics_timeline_ok") : t("metrics_timeline_failed")}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
