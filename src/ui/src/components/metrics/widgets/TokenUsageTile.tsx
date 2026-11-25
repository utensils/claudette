import { useTranslation } from "react-i18next";
import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Sparkline } from "../primitives/Sparkline";
import { formatTokens } from "../../chat/formatTokens";

export function TokenUsageTile() {
  const { t } = useTranslation();
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const input = metrics?.totalInputTokens30d ?? 0;
  const output = metrics?.totalOutputTokens30d ?? 0;
  const total = input + output;
  const cacheRate = metrics?.cacheHitRate30d ?? 0;
  const series = metrics?.tokensDaily30d ?? [];

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t("metrics_tokens_title")}</span>
      <div className={styles.tileValue}>{formatTokens(total)}</div>
      <span className={styles.tileSub}>
        {t("metrics_tokens_in_out_summary", {
          input: formatTokens(input),
          output: formatTokens(output),
        })}
        {total > 0
          ? t("metrics_cached", { percent: Math.round(cacheRate * 100) })
          : null}
      </span>
      <div style={{ marginTop: 4 }}>
        <Sparkline values={series} title={t("metrics_daily_tokens")} />
      </div>
    </div>
  );
}
