import { describe, it, expect } from "vitest";
import { pickMeterUsageFromResult } from "./pickMeterUsageFromResult";
import type { StreamEvent } from "../types/agent-events";

type ResultEvent = Extract<StreamEvent, { type: "result" }>;

function make(usage: ResultEvent["usage"]): ResultEvent {
  return { type: "result", subtype: "success", usage };
}

describe("pickMeterUsageFromResult", () => {
  it("returns null when usage is null", () => {
    expect(pickMeterUsageFromResult(make(null))).toBeNull();
  });

  it("returns null when usage is undefined (aggregate absent and no iterations)", () => {
    expect(pickMeterUsageFromResult(make(undefined))).toBeNull();
  });

  it("prefers iterations[0] over the top-level aggregate", () => {
    // The top-level fields represent the 69-iteration aggregate; the
    // iteration's fields represent the final API call's per-call usage.
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 62,
        output_tokens: 41_322,
        cache_creation_input_tokens: 153_239,
        cache_read_input_tokens: 4_695_413,
        iterations: [
          {
            input_tokens: 1,
            output_tokens: 611,
            cache_read_input_tokens: 131_890,
            cache_creation_input_tokens: 573,
          },
        ],
      }),
    );
    expect(usage).toEqual({
      inputTokens: 1,
      outputTokens: 611,
      cacheReadTokens: 131_890,
      cacheCreationTokens: 573,
    });
  });

  it("falls back to the top-level aggregate when iterations is absent", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 5_000,
      }),
    );
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 5_000,
      cacheCreationTokens: undefined,
    });
  });

  it("falls back to the aggregate when iterations is an empty array", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 100,
        output_tokens: 200,
        iterations: [],
      }),
    );
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(200);
  });

  it("treats null cache fields as undefined", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    );
    expect(usage?.cacheReadTokens).toBeUndefined();
    expect(usage?.cacheCreationTokens).toBeUndefined();
  });

  it("returns null if neither input nor output is present", () => {
    const usage = pickMeterUsageFromResult(
      make({
        input_tokens: undefined as unknown as number,
        output_tokens: undefined as unknown as number,
      }),
    );
    expect(usage).toBeNull();
  });
});
