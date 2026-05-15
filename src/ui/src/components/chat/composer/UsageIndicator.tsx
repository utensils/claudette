import { useEffect, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { selectUsageBucket } from "./selectUsageBucket";
import styles from "./UsageIndicator.module.css";

interface UsageIndicatorProps {
  sessionId: string;
}

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-stopped)";
  if (pct >= 60) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

function formatResetCountdown(resetsAt: string | number): string {
  const ms =
    typeof resetsAt === "string"
      ? new Date(resetsAt).getTime()
      : resetsAt < 1e12
        ? resetsAt * 1000
        : resetsAt;
  const diffSec = Math.max(0, (ms - Date.now()) / 1000);
  if (diffSec <= 0) return "resetting…";
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Compact usage-allocation indicator for the composer toolbar.
 *
 * Vertical bar that drains as the most-relevant Anthropic subscription
 * limit fills (inverse of context meter). When exhausted, swaps to a
 * "Resets in <countdown>" readout.
 *
 * Hidden unless the experimental Usage Insights flag is on AND usage
 * data has been fetched at least once. No-data → render nothing,
 * matches existing ContextMeter behavior.
 */
export function UsageIndicator({ sessionId }: UsageIndicatorProps) {
  const enabled = useAppStore((s) => s.usageInsightsEnabled);
  const usage = useAppStore((s) => s.claudeCodeUsage);
  const selectedModel = useAppStore(
    (s) => s.selectedModel[sessionId] ?? "opus",
  );

  // Tick once a minute so the countdown stays fresh without re-rendering
  // the whole composer on every animation frame.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled || !usage) return null;
  const bucket = selectUsageBucket({ usage, selectedModel });
  if (!bucket) return null;

  const pct = Math.min(bucket.utilization, 100);
  // Inverse of context meter — bar *drains* as utilization rises.
  const remainingHeight = Math.max(0, 100 - pct);
  const color = barColor(pct);
  const tooltip = bucket.exhausted
    ? `${bucket.label} exhausted — resets in ${formatResetCountdown(bucket.resetsAt)}`
    : `${bucket.label}: ${Math.floor(pct)}% used`;

  return (
    <div
      className={`${styles.indicator} ${bucket.exhausted ? styles.exhausted : ""}`}
      title={tooltip}
      role="status"
      aria-label={tooltip}
    >
      <div className={styles.bar}>
        <div
          className={styles.barFill}
          style={{ height: `${remainingHeight}%`, background: color }}
        />
      </div>
      {bucket.exhausted ? (
        <span className={styles.countdown}>
          ↻ {formatResetCountdown(bucket.resetsAt)}
        </span>
      ) : (
        <span className={styles.readout}>{Math.floor(100 - pct)}%</span>
      )}
    </div>
  );
}
