import { describe, it, expect } from "vitest";
import { selectUsageBucket } from "./selectUsageBucket";
import type { ClaudeCodeUsage, UsageLimit } from "../../../types/usage";

function limit(utilization: number, resetsAt = "2026-06-01T00:00:00Z"): UsageLimit {
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

describe("selectUsageBucket", () => {
  it("returns null when no limits are present", () => {
    const bucket = selectUsageBucket({
      usage: usage({}),
      selectedModel: "opus",
    });
    expect(bucket).toBeNull();
  });

  it("returns the single limit when only one is set", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(42) }),
      selectedModel: "opus",
    });
    expect(bucket).not.toBeNull();
    expect(bucket?.utilization).toBe(42);
    expect(bucket?.label).toBe("Session (5h)");
    expect(bucket?.exhausted).toBe(false);
  });

  it("picks the most-constraining limit among many", () => {
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(30),
        seven_day: limit(55),
        seven_day_sonnet: limit(80),
        seven_day_opus: limit(20),
      }),
      selectedModel: "sonnet",
    });
    expect(bucket?.label).toBe("Week (Sonnet)");
    expect(bucket?.utilization).toBe(80);
    expect(bucket?.exhausted).toBe(false);
  });

  it("marks exhausted at >= 100", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(100) }),
      selectedModel: "opus",
    });
    expect(bucket?.exhausted).toBe(true);
  });

  it("does not mark exhausted at 99", () => {
    const bucket = selectUsageBucket({
      usage: usage({ five_hour: limit(99) }),
      selectedModel: "opus",
    });
    expect(bucket?.exhausted).toBe(false);
  });

  it("preserves the resetsAt value from the picked limit", () => {
    const bucket = selectUsageBucket({
      usage: usage({
        five_hour: limit(20, "2026-07-01T12:00:00Z"),
        seven_day: limit(70, "2026-07-08T00:00:00Z"),
      }),
      selectedModel: "opus",
    });
    expect(bucket?.resetsAt).toBe("2026-07-08T00:00:00Z");
  });
});
