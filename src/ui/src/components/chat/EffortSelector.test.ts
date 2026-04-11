import { describe, it, expect } from "vitest";
import { isEffortSupported, isMaxEffortAllowed, EFFORT_LEVELS } from "./EffortSelector";

describe("isEffortSupported", () => {
  it("returns true for opus", () => {
    expect(isEffortSupported("opus")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isEffortSupported("claude-opus-4-6")).toBe(true);
  });

  it("returns true for sonnet", () => {
    expect(isEffortSupported("sonnet")).toBe(true);
  });

  it("returns false for haiku", () => {
    expect(isEffortSupported("haiku")).toBe(false);
  });

  it("returns false for unknown models", () => {
    expect(isEffortSupported("unknown-model")).toBe(false);
  });
});

describe("isMaxEffortAllowed", () => {
  it("returns true for opus", () => {
    expect(isMaxEffortAllowed("opus")).toBe(true);
  });

  it("returns true for claude-opus-4-6", () => {
    expect(isMaxEffortAllowed("claude-opus-4-6")).toBe(true);
  });

  it("returns false for sonnet", () => {
    expect(isMaxEffortAllowed("sonnet")).toBe(false);
  });

  it("returns false for haiku", () => {
    expect(isMaxEffortAllowed("haiku")).toBe(false);
  });
});

describe("EFFORT_LEVELS", () => {
  it("contains auto, low, medium, high, max in order", () => {
    const ids = EFFORT_LEVELS.map((l) => l.id);
    expect(ids).toEqual(["auto", "low", "medium", "high", "max"]);
  });
});
