import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Ring } from "../primitives/Ring";

export function SuccessRing() {
  const { t } = useTranslation();
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const rate = metrics?.successRate30d ?? 0;

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t("metrics_success_title")}</span>
      <div className={styles.tileRow} style={{ marginTop: 4 }}>
        <Ring value={rate} />
        <div className={styles.tileSub} style={{ flex: 1 }}>
          {t("metrics_completed_sessions")}
        </div>
      </div>
    </div>
  );
}
