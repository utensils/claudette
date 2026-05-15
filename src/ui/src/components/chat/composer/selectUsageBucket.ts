import type { ClaudeCodeUsage, UsageLimit } from "../../../types/usage";

export interface UsageBucket {
  /** Which limit this bucket represents — used as a label and aria description. */
  label: string;
  /** 0-100. Render as a vertical bar that goes *down* as utilization rises. */
  utilization: number;
  /** Absolute reset time (string or epoch s/ms — matches UsageLimit shape). */
  resetsAt: string | number;
  /** True when utilization >= 100 — switches the indicator into countdown mode. */
  exhausted: boolean;
}

interface SelectInput {
  usage: ClaudeCodeUsage;
}

/**
 * Decide which of the (up to 4) usage limits the composer indicator should
 * surface. The usage API returns:
 *
 *   - five_hour          : Current rolling 5h session window
 *   - seven_day          : Weekly cap, aggregated across all models
 *   - seven_day_sonnet   : Weekly cap, Sonnet-only
 *   - seven_day_opus     : Weekly cap, Opus-only
 *
 * The bar shows one bucket at a time. We pick the most-constraining
 * (max utilization) — it surfaces whichever limit the user will hit first
 * regardless of which model they switch to. Returns `null` when there's
 * nothing meaningful to display (no usage data returned by the API).
 */
export function selectUsageBucket(input: SelectInput): UsageBucket | null {
  const { usage } = input;

  const candidates: { limit: UsageLimit; label: string }[] = [];
  if (usage.usage.five_hour) {
    candidates.push({ limit: usage.usage.five_hour, label: "Session (5h)" });
  }
  if (usage.usage.seven_day) {
    candidates.push({ limit: usage.usage.seven_day, label: "Week (all)" });
  }
  if (usage.usage.seven_day_sonnet) {
    candidates.push({
      limit: usage.usage.seven_day_sonnet,
      label: "Week (Sonnet)",
    });
  }
  if (usage.usage.seven_day_opus) {
    candidates.push({
      limit: usage.usage.seven_day_opus,
      label: "Week (Opus)",
    });
  }

  if (candidates.length === 0) return null;

  const picked = candidates.reduce((best, c) =>
    c.limit.utilization > best.limit.utilization ? c : best,
  );

  return {
    label: picked.label,
    utilization: picked.limit.utilization,
    resetsAt: picked.limit.resets_at,
    exhausted: picked.limit.utilization >= 100,
  };
}
