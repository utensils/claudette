import type { ClaudeCodeUsage, UsageLimit } from "../../../types/usage";

/** Window length in milliseconds, derived from the bucket key. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface UsageBucket {
  /** Stable key for the bucket; matches the `usage` field name. */
  key: "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus";
  /** Human-readable label — used in the indicator tooltip and the popover. */
  label: string;
  /** 0-100. */
  utilization: number;
  /** Absolute reset time (string or epoch s/ms — matches UsageLimit shape). */
  resetsAt: string | number;
  /** Total length of the limit window in ms (5h or 7d). */
  windowMs: number;
  /** True when utilization >= 100. */
  exhausted: boolean;
}

interface SelectInput {
  usage: ClaudeCodeUsage;
  /** Override "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

function parseResetMs(resetsAt: string | number): number {
  if (typeof resetsAt === "string") return new Date(resetsAt).getTime();
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/**
 * Build the full list of buckets the API returned, in stable display order
 * (session → week-all → week-sonnet → week-opus). Used both for the
 * compact indicator's selection logic AND for the click-to-expand popover.
 */
export function getAllUsageBuckets(usage: ClaudeCodeUsage): UsageBucket[] {
  const out: UsageBucket[] = [];
  const push = (
    key: UsageBucket["key"],
    limit: UsageLimit | null | undefined,
    label: string,
    windowMs: number,
  ) => {
    if (!limit) return;
    out.push({
      key,
      label,
      utilization: limit.utilization,
      resetsAt: limit.resets_at,
      windowMs,
      exhausted: limit.utilization >= 100,
    });
  };
  push("five_hour", usage.usage.five_hour, "Session (5h)", FIVE_HOUR_MS);
  push("seven_day", usage.usage.seven_day, "Week (all)", SEVEN_DAY_MS);
  push("seven_day_sonnet", usage.usage.seven_day_sonnet, "Week (Sonnet)", SEVEN_DAY_MS);
  push("seven_day_opus", usage.usage.seven_day_opus, "Week (Opus)", SEVEN_DAY_MS);
  return out;
}

/**
 * Burn-rate score for a single bucket. Higher score = more urgent.
 *
 * Intuition: `utilization` alone misses that a 25% session window resetting
 * in 4h is on track to blow past 100%, while a 25% weekly window resetting
 * in 6 days is fine. We compare against fraction-of-window-elapsed instead.
 *
 *   fractionElapsed = (windowMs - msUntilReset) / windowMs   ∈ (0, 1]
 *   score           = utilization / fractionElapsed
 *
 * Edge cases YOU need to decide:
 *   - fractionElapsed very small (just past reset): score blows up. Cap it?
 *   - msUntilReset <= 0 (clock skew / stale data): treat as fully elapsed?
 *   - Exhausted buckets (>=100): always rank above non-exhausted?
 *
 * Implement below — see [[selectUsageBucket]] for how it's consumed.
 */
function burnRateScore(bucket: UsageBucket, now: number): number {
  // TODO(you): return a score where higher = more urgent.
  //
  // Available:
  //   bucket.utilization  // 0-100
  //   bucket.windowMs     // 5h or 7d in ms
  //   bucket.resetsAt     // pass through parseResetMs() to get epoch ms
  //   bucket.exhausted    // utilization >= 100
  //
  // Decide: how do you handle a near-zero fractionElapsed? Do you want
  // exhausted to dominate? Should very-fresh windows (< ~5 min elapsed)
  // fall back to plain utilization to avoid scoring noise?
  void bucket;
  void now;
  return 0;
}

/**
 * Pick the bucket the composer indicator should surface.
 *
 * Returns `null` when no usage data is present. Otherwise scores every
 * candidate via [[burnRateScore]] and returns the max. On exact ties the
 * earlier bucket wins (display order: session → week-all → sonnet → opus),
 * which matches the order `getAllUsageBuckets` emits.
 */
export function selectUsageBucket(input: SelectInput): UsageBucket | null {
  const { usage, now = Date.now() } = input;
  const buckets = getAllUsageBuckets(usage);
  if (buckets.length === 0) return null;
  return buckets.reduce((best, b) =>
    burnRateScore(b, now) > burnRateScore(best, now) ? b : best,
  );
}

export { parseResetMs };
