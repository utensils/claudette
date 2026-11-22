import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Heatmap } from "../primitives/Heatmap";

export function SessionHeatmap() {
  const { t } = useTranslation();
  const cells = useAppStore((s) => s.analyticsMetrics?.heatmap);
  const hasData = cells?.some((c) => c.count > 0) ?? false;

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>{t("metrics_activity_title")}</span>
      {hasData && cells ? (
        <Heatmap cells={cells} />
      ) : (
        <div className={styles.empty}>{t("metrics_no_data")}</div>
      )}
    </div>
  );
}
