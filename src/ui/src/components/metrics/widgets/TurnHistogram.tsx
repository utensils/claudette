import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Histogram } from "../primitives/Histogram";

const LABELS = ["≤2", "≤4", "≤8", "≤16", "≤32", "≤64", "≤128", "129+"];

export function TurnHistogram() {
  const { t } = useTranslation();
  const buckets = useAppStore((s) => s.analyticsMetrics?.turnHistogram);
  const hasData = buckets?.some((b) => b > 0) ?? false;
  const padded =
    buckets && buckets.length === 8 ? buckets : new Array(8).fill(0);

  return (
    <div className={styles.panel}>
      <span className={styles.panelTitle}>{t("metrics_turns_per_session")}</span>
      {hasData ? (
        <Histogram buckets={padded} labels={LABELS} />
      ) : (
        <div className={styles.empty}>{t("metrics_no_data")}</div>
      )}
    </div>
  );
}
