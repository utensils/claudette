import type { ClaudeCodeUsage, UsageLimit } from "../../../types/usage";
import { parseResetMs } from "../../../utils/usageReset";

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
 * Floor on fractionElapsed when computing the burn-rate score. Prevents
 * a freshly-reset window with a tiny amount of utilization from scoring
 * absurdly high — the first 10% of a window (~30 min of a 5h session,
 * ~17h of a weekly window) is too noisy to read a trend from.
 */
const MIN_FRACTION_ELAPSED = 0.1;

/**
 * Burn-rate score for a single bucket. Higher score = more urgent.
 *
 *   fractionElapsed = (windowMs - msUntilReset) / windowMs
 *   score           = utilization / max(fractionElapsed, MIN_FRACTION_ELAPSED)
 *
 * Surfaces "which limit will you hit first at current pace" rather than
 * "which has the highest %". Example: a 30% session 2h into its 5h
 * window (40% elapsed) scores ~75; a 10% weekly bucket ~2.8d into its
 * 7d window (40% elapsed) scores ~25 — same elapsed fraction, but the
 * session is on track to exhaust three times faster, so it wins the
 * indicator slot.
 *
 * Edge cases:
 *   - Exhausted (>=100): returns Infinity. A maxed bucket should always
 *     own the indicator slot — that's the actionable signal.
 *   - msUntilReset <= 0 (clock skew or stale data): treat the window as
 *     fully elapsed (fractionElapsed = 1, score = utilization). Hides
 *     stale-but-low buckets while still surfacing high ones.
 *   - Zero utilization: scores 0 regardless of windowMs (untouched limit
 *     should never win).
 */
function burnRateScore(bucket: UsageBucket, now: number): number {
  if (bucket.exhausted) return Number.POSITIVE_INFINITY;
  if (bucket.utilization <= 0) return 0;

  const msUntilReset = parseResetMs(bucket.resetsAt) - now;
  const rawFractionElapsed = (bucket.windowMs - msUntilReset) / bucket.windowMs;
  const fractionElapsed =
    msUntilReset <= 0 ? 1 : Math.max(rawFractionElapsed, MIN_FRACTION_ELAPSED);

  return bucket.utilization / fractionElapsed;
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

