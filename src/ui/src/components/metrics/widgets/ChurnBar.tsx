import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { HBar } from "../primitives/HBar";

function format(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return n.toString();
}

export function ChurnBar() {
  const { t } = useTranslation();
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const adds = metrics?.additions7d ?? 0;
  const dels = metrics?.deletions7d ?? 0;

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t("metrics_churn_title")}</span>
      <div className={styles.tileRow}>
        <span className={`${styles.tileValue} ${styles.tileValuePositive}`}>
          +{format(adds)}
        </span>
        <span className={`${styles.tileValue} ${styles.tileValueNegative}`}>
          −{format(dels)}
        </span>
      </div>
      <div className={styles.tileChart}>
        <HBar additions={adds} deletions={dels} />
      </div>
    </div>
  );
}
