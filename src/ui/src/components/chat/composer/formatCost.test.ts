import { describe, it, expect } from "vitest";
import { estimateCost, formatCost } from "./formatCost";

describe("estimateCost", () => {
  it("returns 0 for 0 tokens", () => {
    expect(estimateCost(0)).toBe(0);
  });

  it("computes cost at $15/M tokens", () => {
    expect(estimateCost(1_000_000)).toBe(15);
    expect(estimateCost(100_000)).toBeCloseTo(1.5);
    expect(estimateCost(200_000)).toBeCloseTo(3.0);
  });
});

describe("formatCost", () => {
  it("shows <$0.01 for very small amounts", () => {
    expect(formatCost(0)).toBe("<$0.01");
    expect(formatCost(0.005)).toBe("<$0.01");
    expect(formatCost(0.009)).toBe("<$0.01");
  });

  it("formats normal amounts with 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.50)).toBe("$1.50");
    expect(formatCost(15.00)).toBe("$15.00");
    expect(formatCost(99.99)).toBe("$99.99");
  });

  it("drops decimals for amounts >= $100", () => {
    expect(formatCost(100)).toBe("$100");
    expect(formatCost(150.75)).toBe("$151");
    expect(formatCost(1000)).toBe("$1000");
  });
});
