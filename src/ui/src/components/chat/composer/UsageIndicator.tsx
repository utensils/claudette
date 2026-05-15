import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { formatResetCountdown, resetCountdown } from "../../../utils/usageReset";
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
 * Vertical bar that fills as the most-urgent Anthropic subscription
 * limit is consumed (burn-rate weighted — see [[selectUsageBucket]]).
 * The readout shows percent *used* to match the popover and Claude
 * Code's own `/usage` panel. Clicking opens a popover with every
 * bucket the API returned.
 */
export function UsageIndicator() {
  const { t } = useTranslation("settings");
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
  const color = barColor(pct);
  // Avoid "resets in resetting…" — when the reset moment has already passed
  // but the API hasn't refreshed yet, fall back to a dedicated key.
  const exhaustedResetting =
    bucket.exhausted && resetCountdown(bucket.resetsAt).resetting;
  const tooltip = bucket.exhausted
    ? exhaustedResetting
      ? t("usage_indicator_tooltip_exhausted_resetting", { label: bucket.label })
      : t("usage_indicator_tooltip_exhausted", {
          label: bucket.label,
          countdown: formatResetCountdown(bucket.resetsAt),
        })
    : t("usage_indicator_tooltip_used", {
        label: bucket.label,
        pct: Math.floor(pct),
      });

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
            style={{ height: `${pct}%`, background: color }}
          />
        </div>
        {bucket.exhausted ? (
          <span className={styles.countdown}>
            ↻ {formatResetCountdown(bucket.resetsAt)}
          </span>
        ) : (
          <span className={styles.readout}>{Math.floor(pct)}%</span>
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
