import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS } from "./EffortSelector";

describe("EFFORT_LEVELS", () => {
  it("contains auto, low, medium, high, xhigh, max in order", () => {
    const ids = EFFORT_LEVELS.map((l) => l.id);
    expect(ids).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
  });
});
