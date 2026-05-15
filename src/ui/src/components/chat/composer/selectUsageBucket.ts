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
  /** Currently selected agent model id ("opus" | "sonnet" | "haiku" | ...). */
  selectedModel: string;
}

/**
 * Decide which of the (up to 4) usage limits the lower-bar indicator should
 * surface. The usage API returns:
 *
 *   - five_hour          : Current rolling 5h session window
 *   - seven_day          : Weekly cap, aggregated across all models
 *   - seven_day_sonnet   : Weekly cap, Sonnet-only
 *   - seven_day_opus     : Weekly cap, Opus-only
 *
 * The bar can only show one bucket at a time, so we have to pick. Common
 * strategies:
 *
 *   (a) Most-constraining        — pick max(utilization). Surfaces whichever
 *                                  limit the user will hit first. Stable, but
 *                                  switches buckets as the user works.
 *   (b) Model-aware              — for Opus selection, prefer seven_day_opus;
 *                                  for Sonnet, prefer seven_day_sonnet; fall
 *                                  back to (a). Closer to "what affects ME
 *                                  right now" but ignores the 5h cap that
 *                                  often bites first.
 *   (c) Session-first            — always prefer five_hour while it has data,
 *                                  fall back to (a). Matches the cadence of
 *                                  a coding session, but hides weekly burn.
 *
 * Returns `null` when there's nothing meaningful to display (no usage data
 * returned by the API).
 */
export function selectUsageBucket(input: SelectInput): UsageBucket | null {
  const { usage, selectedModel } = input;

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

  // TODO(learning): pick a strategy. The simplest viable thing is below
  // (most-constraining), but the user may want model-aware or session-first.
  // See doc-comment above for trade-offs. Replace this block with your
  // chosen selection logic (5-10 lines).
  //
  // Inputs available: `candidates` (label + limit), `selectedModel`.
  // Return: a single { limit, label } from `candidates`.
  void selectedModel; // silence unused-param lint until the user wires it up
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
