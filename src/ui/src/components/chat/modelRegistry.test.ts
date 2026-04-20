import { describe, it, expect } from "vitest";
import { MODELS } from "./modelRegistry";

describe("modelRegistry", () => {
  it("every model has a positive integer contextWindowTokens", () => {
    for (const m of MODELS) {
      expect(m.contextWindowTokens, `model ${m.id} is missing contextWindowTokens`).toBeTypeOf("number");
      expect(m.contextWindowTokens, `model ${m.id} has non-positive contextWindowTokens`).toBeGreaterThan(0);
      expect(Number.isInteger(m.contextWindowTokens), `model ${m.id} has non-integer contextWindowTokens`).toBe(true);
    }
  });

  // `"opus"` is the 1M alias of Opus 4.7 whose id lacks the `[1m]` suffix
  // other 1M variants use. Keep the explicit `id === "opus"` check — removing
  // it would silently misclassify the alias as a 200k model.
  it("1M-context variants report 1_000_000", () => {
    const oneM = MODELS.filter((m) => m.id === "opus" || m.id.endsWith("[1m]"));
    expect(oneM.length).toBeGreaterThan(0);
    for (const m of oneM) {
      expect(m.contextWindowTokens, m.id).toBe(1_000_000);
    }
  });

  it("standard variants report 200_000", () => {
    const standard = MODELS.filter((m) => m.id !== "opus" && !m.id.endsWith("[1m]"));
    expect(standard.length).toBeGreaterThan(0);
    for (const m of standard) {
      expect(m.contextWindowTokens, m.id).toBe(200_000);
    }
  });
});
