import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Timeline } from "../primitives/Timeline";
import type { SessionDot } from "../../../types/metrics";

const EMPTY_DOTS: SessionDot[] = [];

export function SessionTimeline() {
  const { t } = useTranslation();
  const dots = useAppStore((s) => s.analyticsMetrics?.recentSessions24h);

  return (
    <div className={`${styles.panel} ${styles.panelFull}`}>
      <span className={styles.panelTitle}>{t("metrics_sessions_24h_title")}</span>
      <Timeline dots={dots ?? EMPTY_DOTS} />
    </div>
  );
}
