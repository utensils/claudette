import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { formatResetCountdown } from "../../../utils/usageReset";
import { selectUsageBucket } from "./selectUsageBucket";
import { UsagePopover } from "./UsagePopover";
import styles from "./UsageIndicator.module.css";

function barColor(pct: number): string {
  if (pct >= 85) return "var(--status-stopped)";
  if (pct >= 60) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

/**
 * Compact usage-allocation indicator for the composer toolbar.
 *
 * Vertical bar that drains as the most-urgent Anthropic subscription
 * limit fills (burn-rate weighted — see [[selectUsageBucket]]). Clicking
 * opens a popover showing every bucket the API returned.
 */
export function UsageIndicator() {
  const enabled = useAppStore((s) => s.usageInsightsEnabled);
  const usage = useAppStore((s) => s.claudeCodeUsage);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Tick once a minute so the countdown stays fresh without re-rendering
  // the whole composer on every animation frame.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled || !usage) return null;
  const bucket = selectUsageBucket({ usage });
  if (!bucket) return null;

  const pct = Math.min(bucket.utilization, 100);
  const remainingHeight = Math.max(0, 100 - pct);
  const color = barColor(pct);
  const tooltip = bucket.exhausted
    ? `${bucket.label} exhausted — resets in ${formatResetCountdown(bucket.resetsAt)}`
    : `${bucket.label}: ${Math.floor(pct)}% used — click for all limits`;

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.indicator} ${bucket.exhausted ? styles.exhausted : ""}`}
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
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
      </button>
      {open && (
        <UsagePopover
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          activeBucketKey={bucket.key}
        />
      )}
    </div>
  );
}
