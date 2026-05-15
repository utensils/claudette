import { describe, it, expect } from "vitest";
import { selectUsageBucket } from "./selectUsageBucket";
import type { ClaudeCodeUsage, UsageLimit } from "../../../types/usage";

function limit(utilization: number, resetsAt: string): UsageLimit {
  return { utilization, resets_at: resetsAt };
}

function usage(partial: Partial<ClaudeCodeUsage["usage"]>): ClaudeCodeUsage {
  return {
    subscription_type: "pro",
    rate_limit_tier: "default_claude_pro",
    fetched_at: Date.now(),
    usage: {
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: null,
      ...partial,
    },
  };
}

// Fixed reference time for deterministic burn-rate scoring.
// Picked so 5h and 7d windows have clean offsets to reason about.
const NOW = Date.parse("2026-06-01T01:00:00Z"); // 1h into a 5h window starting at 00:00Z

/** Reset time N hours from NOW. */
const inHours = (h: number) =>
  new Date(NOW + h * 60 * 60 * 1000).toISOString();
/** Reset time N days from NOW. */
const inDays = (d: number) =>
  new Date(NOW + d * 24 * 60 * 60 * 1000).toISOString();

describe("selectUsageBucket", () => {
  it("returns null when no limits are present", () => {
    const bucket = selectUsageBucket({ usage: usage({}), now: NOW });
    expect(bucket).toBeNull();
  });

  it("returns the single limit when only one is set", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(42, inHours(4)) }),
      now: NOW,
    });
    expect(bucket).not.toBeNull();
    expect(bucket?.utilization).toBe(42);
    expect(bucket?.label).toBe("Session (5h)");
    expect(bucket?.key).toBe("five_hour");
    expect(bucket?.exhausted).toBe(false);
    expect(bucket?.windowMs).toBe(5 * 60 * 60 * 1000);
  });

  it("session at 25% / 1h-in beats weekly at 4% / 1d-in (burn-rate)", () => {
    // 5h session, 4h remaining → 20% elapsed → score 25/0.2 = 125
    // 7d weekly, 6d remaining → ~14% elapsed → score ~28
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(25, inHours(4)),
        seven_day: limit(4, inDays(6)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("five_hour");
  });

  it("high-utilization weekly beats low-utilization session at same elapsed fraction", () => {
    // 5h session at 2.5h elapsed (50%): 5/0.5 = 10
    // 7d weekly at 5d elapsed (~71%): 80/0.71 ≈ 112
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(5, inHours(2.5)),
        seven_day_sonnet: limit(80, inDays(2)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("seven_day_sonnet");
    expect(bucket?.label).toBe("Week (Sonnet)");
  });

  it("exhausted bucket dominates every non-exhausted bucket", () => {
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(100, inHours(2)), // exhausted, would score Infinity
        seven_day_sonnet: limit(95, inDays(1)), // very high but not exhausted
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("five_hour");
    expect(bucket?.exhausted).toBe(true);
  });

  it("MIN_FRACTION_ELAPSED floor prevents fresh-window noise from winning", () => {
    // Session just opened (4.99h remaining of 5h → ~0.2% elapsed,
    // floored to 10%). 1% util / 0.1 = 10.
    // Weekly mid-life: 50% util / 0.5 = 100. Weekly wins.
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(1, inHours(4.99)),
        seven_day: limit(50, inDays(3.5)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("seven_day");
  });

  it("treats stale data (resetsAt in the past) as a fully-consumed window", () => {
    // Session resetsAt in the past → fractionElapsed = 1 → score = utilization (50)
    // Weekly mid-life with high util → score ~140. Weekly wins.
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(50, inHours(-1)),
        seven_day: limit(60, inDays(4)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("seven_day");
  });

  it("breaks ties in display order (session before weekly when both exhausted)", () => {
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(100, inHours(2)),
        seven_day: limit(100, inDays(3)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("five_hour");
  });

  it("marks exhausted at >= 100", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(100, inHours(2)) }),
      now: NOW,
    });
    expect(bucket?.exhausted).toBe(true);
  });

  it("does not mark exhausted at 99", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(99, inHours(2)) }),
      now: NOW,
    });
    expect(bucket?.exhausted).toBe(false);
  });

  it("preserves resetsAt from the picked bucket", () => {
    const sessionReset = inHours(4);
    const weeklyReset = inDays(6);
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(25, sessionReset),
        seven_day: limit(4, weeklyReset),
      }),
      now: NOW,
    });
    expect(bucket?.resetsAt).toBe(sessionReset);
  });

  it("ignores zero-utilization buckets when something else has activity", () => {
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(0, inHours(4)),
        seven_day: limit(15, inDays(3)),
      }),
      now: NOW,
    });
    expect(bucket?.key).toBe("seven_day");
  });
});
