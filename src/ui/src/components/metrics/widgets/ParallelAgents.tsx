import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";

export function ParallelAgents() {
  const { t } = useTranslation();
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const active = metrics?.activeSessions ?? 0;
  const today = metrics?.sessionsToday ?? 0;

  return (
    <div className={`${styles.tile} ${active > 0 ? styles.pulseGlow : ""}`}>
      <span className={styles.tileLabel}>{t("metrics_active_agents")}</span>
      <div>
        <div className={`${styles.tileValue} ${styles.tileValueAccent}`}>
          {active}
        </div>
        <div className={styles.tileSub}>{t("metrics_sessions_today", { count: today })}</div>
      </div>
    </div>
  );
}
