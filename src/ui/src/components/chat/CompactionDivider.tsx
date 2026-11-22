import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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

function triggerLabel(trigger: string, t: TFunction<"chat">): string {
  if (trigger === "manual") return t("compaction_trigger_manual");
  // "auto" is Claude CLI's auto-trigger; "threshold" is Pi's
  // equivalent (auto-compaction crossed the keep-recent budget).
  if (trigger === "auto" || trigger === "threshold") return t("compaction_trigger_automatic");
  // "overflow" is Pi forcing a compaction because the context window
  // is exhausted.
  if (trigger === "overflow") return t("compaction_trigger_overflow");
  if (trigger === "codex") return t("compaction_trigger_codex");
  return t("compaction_trigger_unknown"); // friendly fallback for unknown triggers
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
  const { t } = useTranslation("chat");
  if (!hasTokenDetail(event)) {
    return (
      <div
        className={styles.divider}
        title={t("compaction_title", { trigger: triggerLabel(event.trigger, t) })}
      >
        <span className={styles.line} aria-hidden="true" />
        <span className={styles.content}>
          <Scissors size={14} aria-hidden="true" />
          <span>{t("compaction_label")}</span>
        </span>
        <span className={styles.line} aria-hidden="true" />
      </div>
    );
  }

  const freed = Math.max(0, event.preTokens - event.postTokens);
  const tooltip = [
    t("compaction_title_with_duration", {
      trigger: triggerLabel(event.trigger, t),
      duration: formatDurationSeconds(event.durationMs),
    }),
    "",
    t("compaction_tokens_before", { count: event.preTokens.toLocaleString("en-US") }),
    t("compaction_tokens_after", { count: event.postTokens.toLocaleString("en-US") }),
    t("compaction_tokens_freed", { count: freed.toLocaleString("en-US") }),
  ].join("\n");

  return (
    <div className={styles.divider} title={tooltip}>
      <span className={styles.line} aria-hidden="true" />
      <span className={styles.content}>
        <Scissors size={14} aria-hidden="true" />
        <span>{t("compaction_label")}</span>
        <span className={styles.arrow}>
          {formatTokens(event.preTokens)} → {formatTokens(event.postTokens)}
        </span>
      </span>
      <span className={styles.line} aria-hidden="true" />
    </div>
  );
}
