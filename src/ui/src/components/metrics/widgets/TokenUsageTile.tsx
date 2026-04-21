import styles from "../metrics.module.css";
import { useAppStore } from "../../../stores/useAppStore";
import { Sparkline } from "../primitives/Sparkline";
import { formatTokens } from "../../chat/formatTokens";

export function TokenUsageTile() {
  const metrics = useAppStore((s) => s.dashboardMetrics);
  const input = metrics?.totalInputTokens30d ?? 0;
  const output = metrics?.totalOutputTokens30d ?? 0;
  const total = input + output;
  const cacheRate = metrics?.cacheHitRate30d ?? 0;
  const series = metrics?.tokensDaily30d ?? [];

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>Tokens · 30d</span>
      <div className={styles.tileValue}>{formatTokens(total)}</div>
      <span className={styles.tileSub}>
        {formatTokens(input)} in · {formatTokens(output)} out
        {total > 0 ? ` · ${Math.round(cacheRate * 100)}% cached` : null}
      </span>
      <div style={{ marginTop: 4 }}>
        <Sparkline values={series} title="daily tokens (30d)" />
      </div>
    </div>
  );
}
