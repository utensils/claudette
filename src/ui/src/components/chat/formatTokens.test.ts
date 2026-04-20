import { describe, it, expect } from "vitest";
import { formatTokens } from "./formatTokens";

describe("formatTokens", () => {
  it("renders values under 1000 as raw integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("renders 1000+ as a k-compact value with one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9876)).toBe("9.8k");
    expect(formatTokens(10_000)).toBe("10.0k");
    expect(formatTokens(199_000)).toBe("199.0k");
  });

  it("floors truncation rather than rounding up", () => {
    // 1299 → 1.299k → "1.2k" (we want to avoid over-reporting)
    expect(formatTokens(1299)).toBe("1.2k");
  });

  it("renders 1M+ as an M-compact value with one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_234_000)).toBe("1.2M");
    expect(formatTokens(9_876_000)).toBe("9.8M");
    expect(formatTokens(10_000_000)).toBe("10.0M");
  });

  it("truncates M-compact values toward zero", () => {
    // 1_299_000 → 1.299M → "1.2M"
    expect(formatTokens(1_299_000)).toBe("1.2M");
  });
});
