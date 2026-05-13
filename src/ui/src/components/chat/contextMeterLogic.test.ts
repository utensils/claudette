import { describe, it, expect } from "vitest";
import { bandForRatio, buildMeterTooltip, computeMeterState } from "./contextMeterLogic";
import type { MeterState } from "./contextMeterLogic";
import type { CompletedTurn } from "../../stores/useAppStore";

function makeState(overrides: Partial<MeterState> = {}): MeterState {
  const totalTokens = overrides.totalTokens ?? 0;
  const capacity = overrides.capacity ?? 1;
  return {
    totalTokens,
    capacity,
    input: overrides.input ?? 0,
    output: overrides.output ?? 0,
    cacheRead: overrides.cacheRead ?? 0,
    cacheCreation: overrides.cacheCreation ?? 0,
    fillPercent: overrides.fillPercent ?? Math.min(totalTokens / capacity, 1) * 100,
    percentRounded: overrides.percentRounded ?? Math.round((totalTokens / capacity) * 100),
    band: overrides.band ?? "normal",
  };
}

function makeTurn(overrides: Partial<CompletedTurn> = {}): CompletedTurn {
  return {
    id: overrides.id ?? "t1",
    activities: [],
    messageCount: 1,
    collapsed: true,
    afterMessageIndex: 0,
    durationMs: overrides.durationMs,
    inputTokens: overrides.inputTokens,
    outputTokens: overrides.outputTokens,
    cacheReadTokens: overrides.cacheReadTokens,
    cacheCreationTokens: overrides.cacheCreationTokens,
  };
}

describe("bandForRatio", () => {
  it("returns normal below 60%", () => {
    expect(bandForRatio(0)).toBe("normal");
    expect(bandForRatio(0.3)).toBe("normal");
    expect(bandForRatio(0.599)).toBe("normal");
  });
  it("returns warn at 60-80%", () => {
    expect(bandForRatio(0.6)).toBe("warn");
    expect(bandForRatio(0.75)).toBe("warn");
    expect(bandForRatio(0.799)).toBe("warn");
  });
  it("returns near-full at 80-90%", () => {
    expect(bandForRatio(0.8)).toBe("near-full");
    expect(bandForRatio(0.85)).toBe("near-full");
    expect(bandForRatio(0.899)).toBe("near-full");
  });
  it("returns critical at 90%+", () => {
    expect(bandForRatio(0.9)).toBe("critical");
    expect(bandForRatio(1)).toBe("critical");
    expect(bandForRatio(1.5)).toBe("critical"); // over-capacity still critical
  });
});

describe("buildMeterTooltip", () => {
  it("formats thousand-separated breakdown with percentage", () => {
    const tooltip = buildMeterTooltip(
      makeState({
        totalTokens: 62_450,
        capacity: 200_000,
        input: 48_200,
        output: 1_000,
        cacheRead: 12_000,
        cacheCreation: 1_250,
      }),
    );
    expect(tooltip).toContain("Context: 62,450 / 200,000 tokens (31%)");
    expect(tooltip).toContain("Input: 48,200");
    expect(tooltip).toContain("Cache read: 12,000");
    expect(tooltip).toContain("Cache creation: 1,250");
    expect(tooltip).toContain("Output: 1,000");
  });

  it("rounds percentage to nearest integer", () => {
    const tooltip = buildMeterTooltip(
      makeState({
        totalTokens: 1000,
        capacity: 3000,
        input: 1000,
      }),
    );
    // 1000/3000 = 0.3333... → 33%
    expect(tooltip).toContain("(33%)");
  });

  it("reports >100% for over-capacity inputs without clamping", () => {
    const tooltip = buildMeterTooltip(
      makeState({
        totalTokens: 300_000,
        capacity: 200_000,
        input: 300_000,
      }),
    );
    // 300000 / 200000 = 1.5 → 150%
    expect(tooltip).toContain("(150%)");
  });
});

describe("computeMeterState", () => {
  it("returns null when turn is undefined", () => {
    const state = computeMeterState(undefined, 200_000);
    expect(state).toBeNull();
  });

  it("returns null when inputTokens is undefined", () => {
    const turn = makeTurn({ outputTokens: 100 });
    expect(computeMeterState(turn, 200_000)).toBeNull();
  });

  it("returns null when outputTokens is undefined", () => {
    const turn = makeTurn({ inputTokens: 100 });
    expect(computeMeterState(turn, 200_000)).toBeNull();
  });

  it("returns null when capacity is zero or missing", () => {
    const turn = makeTurn({ inputTokens: 100, outputTokens: 50 });
    expect(computeMeterState(turn, 0)).toBeNull();
    expect(computeMeterState(turn, undefined)).toBeNull();
  });

  it("sums all four token fields into totalTokens", () => {
    const turn = makeTurn({
      inputTokens: 48_200,
      outputTokens: 1_000,
      cacheReadTokens: 12_000,
      cacheCreationTokens: 1_250,
    });
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    expect(state!.totalTokens).toBe(62_450);
    expect(state!.input).toBe(48_200);
    expect(state!.output).toBe(1_000);
    expect(state!.cacheRead).toBe(12_000);
    expect(state!.cacheCreation).toBe(1_250);
  });

  it("prefers runtime model context window from usage over registry capacity", () => {
    const turn = {
      ...makeTurn({
        inputTokens: 100_000,
        outputTokens: 36_000,
      }),
      modelContextWindow: 272_000,
    };
    const state = computeMeterState(turn, 400_000);
    expect(state).not.toBeNull();
    expect(state!.capacity).toBe(272_000);
    expect(state!.percentRounded).toBe(50);
  });

  it("prefers authoritative total tokens when backend provides them", () => {
    const turn = {
      ...makeTurn({
        inputTokens: 80_000,
        cacheReadTokens: 20_000,
        outputTokens: 10_000,
      }),
      totalTokens: 105_000,
    };
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    expect(state!.totalTokens).toBe(105_000);
    expect(state!.percentRounded).toBe(53);
  });

  it("treats missing cache tokens as zero", () => {
    const turn = makeTurn({ inputTokens: 1_000, outputTokens: 200 });
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    expect(state!.totalTokens).toBe(1_200);
    expect(state!.cacheRead).toBe(0);
    expect(state!.cacheCreation).toBe(0);
  });

  it("caps fillPercent at 100 but leaves percentRounded uncapped when over capacity", () => {
    const turn = makeTurn({ inputTokens: 300_000, outputTokens: 1_000 });
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    expect(state!.fillPercent).toBe(100);
    // 301_000 / 200_000 = 1.505 → rounded to 151
    expect(state!.percentRounded).toBe(151);
    expect(state!.band).toBe("critical");
  });

  it("rejects NaN token values (treats them as missing)", () => {
    const turn = makeTurn({ inputTokens: Number.NaN, outputTokens: 100 });
    expect(computeMeterState(turn, 200_000)).toBeNull();
  });

  it("treats NaN cache tokens as zero, not NaN", () => {
    // `?? 0` would NOT replace NaN (it only catches null/undefined), so
    // a stray NaN in a cache field must be caught by Number.isFinite to
    // avoid poisoning totalTokens / fillPercent.
    const turn = makeTurn({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: Number.NaN,
      cacheCreationTokens: Number.NaN,
    });
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    expect(state!.cacheRead).toBe(0);
    expect(state!.cacheCreation).toBe(0);
    expect(state!.totalTokens).toBe(1_200);
    expect(Number.isFinite(state!.fillPercent)).toBe(true);
  });

  it("computes fillPercent as ratio * 100 when under capacity", () => {
    const turn = makeTurn({ inputTokens: 50_000, outputTokens: 1_000 });
    const state = computeMeterState(turn, 200_000);
    expect(state).not.toBeNull();
    // 51000 / 200000 = 0.255 → 25.5%
    expect(state!.fillPercent).toBeCloseTo(25.5, 5);
    expect(state!.band).toBe("normal");
  });

  it("assigns the correct band for each threshold", () => {
    const capacity = 200_000;
    // 50% → normal
    expect(computeMeterState(makeTurn({ inputTokens: 100_000, outputTokens: 0 }), capacity)!.band).toBe("normal");
    // 70% → warn
    expect(computeMeterState(makeTurn({ inputTokens: 140_000, outputTokens: 0 }), capacity)!.band).toBe("warn");
    // 85% → near-full
    expect(computeMeterState(makeTurn({ inputTokens: 170_000, outputTokens: 0 }), capacity)!.band).toBe("near-full");
    // 95% → critical
    expect(computeMeterState(makeTurn({ inputTokens: 190_000, outputTokens: 0 }), capacity)!.band).toBe("critical");
  });
});
