import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Sparkline } from "../primitives/Sparkline";

export function CommitsSparkline() {
  const { t } = useTranslation();
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const today = metrics?.commitsToday ?? 0;
  const series = metrics?.commitsDaily14d ?? [];

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t("metrics_commits_title")}</span>
      <div className={styles.tileRow}>
        <div className={styles.tileValue}>{today}</div>
        <div style={{ flex: 1, marginLeft: 10 }}>
          <Sparkline values={series} title={t("metrics_commits_per_day")} />
        </div>
      </div>
      <div className={styles.tileSub}>{t("metrics_today")}</div>
    </div>
  );
}
