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
  // "auto" is Claude CLI's auto-trigger; "threshold" is Pi's
  // equivalent (auto-compaction crossed the keep-recent budget).
  if (trigger === "auto" || trigger === "threshold") return "automatic";
  // "overflow" is Pi forcing a compaction because the context window
  // is exhausted.
  if (trigger === "overflow") return "context full";
  if (trigger === "codex") return "Codex";
  return "compaction"; // friendly fallback for unknown triggers
}

/** True when the sentinel carries the Claude-CLI-shaped pre/post/duration
 *  numbers. The Codex path emits a sentinel with all three zeroed because
 *  Codex's `ContextCompaction` thread item doesn't include them — render
 *  that case without the misleading `0 → 0` arrow. */
function hasTokenDetail(event: CompactionEvent): boolean {
  return event.preTokens > 0 || event.postTokens > 0 || event.durationMs > 0;
}

/**
 * Timeline divider rendered at a compact_boundary point. Shows the
 * pre → post token drop at a glance; tooltip carries the full breakdown.
 * Falls back to a label-only render when the underlying harness can't
 * supply token counts (currently Codex Native).
 */
export function CompactionDivider({ event }: CompactionDividerProps) {
  if (!hasTokenDetail(event)) {
    return (
      <div
        className={styles.divider}
        title={`Context compacted (${triggerLabel(event.trigger)})`}
      >
        <span className={styles.line} aria-hidden="true" />
        <span className={styles.content}>
          <Scissors size={14} aria-hidden="true" />
          <span>Context compacted</span>
        </span>
        <span className={styles.line} aria-hidden="true" />
      </div>
    );
  }

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
