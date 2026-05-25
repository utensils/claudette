import { type RefObject, useEffect, useRef } from "react";

import type { UsageBucket, UsageSnapshot } from "../../../types/usage";
import styles from "./UsagePopover.module.css";

interface UsagePopoverProps {
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  snapshot: UsageSnapshot;
  /** Key of the bucket the compact indicator is currently surfacing —
   *  highlighted in the list so the user can match the chip to a row. */
  activeBucketKey?: string;
}

function bandColor(pct: number): string {
  if (pct >= 0.85) return "var(--status-stopped)";
  if (pct >= 0.6) return "var(--context-meter-warn)";
  return "var(--accent-primary)";
}

function bucketRow(bucket: UsageBucket, isActive: boolean) {
  const pct = bucket.is_bounded ? Math.min(bucket.utilization, 1.0) : 0;
  const color = bucket.is_bounded ? bandColor(pct) : "var(--accent-primary)";
  const fillStyle = bucket.is_bounded
    ? { width: `${pct * 100}%`, background: color }
    : { width: "100%", background: color, opacity: 0.25 };

  return (
    <li
      key={bucket.key}
      className={`${styles.bucket} ${isActive ? styles.active : ""}`}
    >
      <div className={styles.bucketHead}>
        <span className={styles.bucketLabel}>{bucket.label}</span>
        <span className={styles.bucketPct} style={{ color }}>
          {bucket.primary_text}
        </span>
      </div>
      <div className={styles.bucketBar}>
        <div className={styles.bucketBarFill} style={fillStyle} />
      </div>
      {bucket.secondary_text && (
        <span className={styles.bucketReset}>{bucket.secondary_text}</span>
      )}
    </li>
  );
}

export function UsagePopover({
  onClose,
  triggerRef,
  snapshot,
  activeBucketKey,
}: UsagePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={popoverRef}
      className={styles.popover}
      role="dialog"
      aria-label={`Usage — ${snapshot.source_label}`}
    >
      <div className={styles.header}>
        <span className={styles.caption}>Usage</span>
        <span className={styles.tier}>{snapshot.source_label}</span>
      </div>

      {snapshot.buckets.length > 0 ? (
        <>
          <ul className={styles.bucketList}>
            {snapshot.buckets.map((b) => bucketRow(b, b.key === activeBucketKey))}
          </ul>
          {snapshot.note && <div className={styles.footnote}>{snapshot.note}</div>}
        </>
      ) : (
        <div className={styles.emptyState}>
          {snapshot.note ?? "Loading usage data..."}
        </div>
      )}
    </div>
  );
}
