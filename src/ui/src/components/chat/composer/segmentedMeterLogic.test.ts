import { describe, it, expect } from "vitest";
import { segmentedBand, stateLabel, segmentedColor } from "./segmentedMeterLogic";

describe("segmentedBand", () => {
  it("returns normal below 60%", () => {
    expect(segmentedBand(0)).toBe("normal");
    expect(segmentedBand(0.1)).toBe("normal");
    expect(segmentedBand(0.42)).toBe("normal");
    expect(segmentedBand(0.599)).toBe("normal");
  });

  it("returns warn at 60% through 84%", () => {
    expect(segmentedBand(0.60)).toBe("warn");
    expect(segmentedBand(0.70)).toBe("warn");
    expect(segmentedBand(0.849)).toBe("warn");
  });

  it("returns critical at 85% and above", () => {
    expect(segmentedBand(0.85)).toBe("critical");
    expect(segmentedBand(0.88)).toBe("critical");
    expect(segmentedBand(0.96)).toBe("critical");
    expect(segmentedBand(1.0)).toBe("critical");
    expect(segmentedBand(1.5)).toBe("critical");
  });
});

describe("stateLabel", () => {
  it("returns healthy below 60%", () => {
    expect(stateLabel(0)).toBe("healthy");
    expect(stateLabel(0.42)).toBe("healthy");
    expect(stateLabel(0.599)).toBe("healthy");
  });

  it("returns filling up from 60% to 84%", () => {
    expect(stateLabel(0.60)).toBe("filling up");
    expect(stateLabel(0.70)).toBe("filling up");
    expect(stateLabel(0.849)).toBe("filling up");
  });

  it("returns nearing limit at 85% and above", () => {
    expect(stateLabel(0.85)).toBe("nearing limit");
    expect(stateLabel(0.96)).toBe("nearing limit");
    expect(stateLabel(1.0)).toBe("nearing limit");
  });
});

describe("segmentedColor", () => {
  it("maps bands to the correct CSS variables", () => {
    expect(segmentedColor("normal")).toBe("var(--accent-primary)");
    expect(segmentedColor("warn")).toBe("var(--badge-ask)");
    expect(segmentedColor("critical")).toBe("var(--status-stopped)");
  });
});
