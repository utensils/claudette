import { Scissors } from "lucide-react";
import { formatTokens } from "./formatTokens";
import type { CompactionEvent } from "../../utils/compactionSentinel";
import styles from "./CompactionDivider.module.css";

interface CompactionDividerProps {
  event: CompactionEvent;
}

function formatDurationSeconds(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function triggerLabel(trigger: string): string {
  if (trigger === "manual") return "manual";
  if (trigger === "auto") return "automatic";
  return "compaction"; // friendly fallback for unknown triggers
}

/**
 * Timeline divider rendered at a compact_boundary point. Shows the
 * pre → post token drop at a glance; tooltip carries the full breakdown.
 */
export function CompactionDivider({ event }: CompactionDividerProps) {
  const freed = Math.max(0, event.preTokens - event.postTokens);
  const tooltip = [
    `Context compacted (${triggerLabel(event.trigger)}, ${formatDurationSeconds(event.durationMs)})`,
    "",
    `Before: ${event.preTokens.toLocaleString("en-US")} tokens`,
    `After:  ${event.postTokens.toLocaleString("en-US")} tokens`,
    `Freed:  ${freed.toLocaleString("en-US")} tokens`,
  ].join("\n");

  return (
    <div className={styles.divider} title={tooltip}>
      <span className={styles.line} aria-hidden="true" />
      <span className={styles.content}>
        <Scissors size={14} aria-hidden="true" />
        <span>Context compacted</span>
        <span className={styles.arrow}>
          {formatTokens(event.preTokens)} → {formatTokens(event.postTokens)}
        </span>
      </span>
      <span className={styles.line} aria-hidden="true" />
    </div>
  );
}
