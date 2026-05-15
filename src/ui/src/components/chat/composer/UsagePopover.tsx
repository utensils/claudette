import { type RefObject, useEffect, useRef } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { formatResetIn } from "../../../utils/usageReset";
import { getAllUsageBuckets, type UsageBucket } from "./selectUsageBucket";
import styles from "./UsagePopover.module.css";

interface UsagePopoverProps {
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  /** Key of the bucket the compact indicator is currently surfacing — highlighted in the list. */
  activeBucketKey?: UsageBucket["key"];
}

function bandColor(pct: number): string {
  if (pct >= 85) return "var(--status-stopped)";
  if (pct >= 60) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

export function UsagePopover({ onClose, triggerRef, activeBucketKey }: UsagePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const usage = useAppStore((s) => s.claudeCodeUsage);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef?.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, triggerRef]);

  if (!usage) return null;
  const buckets = getAllUsageBuckets(usage);
  if (buckets.length === 0) return null;

  const tier = usage.subscription_type
    ? usage.subscription_type.charAt(0).toUpperCase() + usage.subscription_type.slice(1)
    : "Anthropic";

  return (
    <div ref={popoverRef} className={styles.popover} role="dialog" aria-label="Anthropic usage limits">
      <div className={styles.header}>
        <span className={styles.caption}>Usage</span>
        <span className={styles.tier}>{tier}</span>
      </div>

      <ul className={styles.bucketList}>
        {buckets.map((b) => {
          const pct = Math.min(b.utilization, 100);
          const color = bandColor(pct);
          const isActive = b.key === activeBucketKey;
          return (
            <li
              key={b.key}
              className={`${styles.bucket} ${isActive ? styles.active : ""}`}
            >
              <div className={styles.bucketHead}>
                <span className={styles.bucketLabel}>{b.label}</span>
                <span className={styles.bucketPct} style={{ color }}>
                  {Math.floor(pct)}%
                </span>
              </div>
              <div className={styles.bucketBar}>
                <div
                  className={styles.bucketBarFill}
                  style={{ width: `${pct}%`, background: color }}
                />
              </div>
              <span className={styles.bucketReset}>{formatResetIn(b.resetsAt)}</span>
            </li>
          );
        })}
      </ul>

      <div className={styles.footnote}>
        Burn-rate weighted: the indicator surfaces whichever limit you’ll hit first
        at your current pace, not just the highest percentage.
      </div>
    </div>
  );
}
