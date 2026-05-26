import { describe, it, expect } from "vitest";
import { envProviderCategoryColor } from "./envProviderCategory";

describe("envProviderCategoryColor", () => {
  it("assigns the canonical slot to each bundled env provider", () => {
    expect(envProviderCategoryColor("env-direnv")).toBe("var(--category-a-fg)");
    expect(envProviderCategoryColor("env-mise")).toBe("var(--category-b-fg)");
    expect(envProviderCategoryColor("env-nix-devshell")).toBe("var(--category-c-fg)");
    expect(envProviderCategoryColor("env-dotenv")).toBe("var(--category-d-fg)");
  });

  it("returns a fallback slot E–H for unknown providers", () => {
    const got = envProviderCategoryColor("env-custom-thing");
    expect(got).toMatch(/^var\(--category-[efgh]-fg\)$/);
  });

  it("is stable across calls — same name always lands in the same slot", () => {
    const first = envProviderCategoryColor("env-some-third-party");
    const second = envProviderCategoryColor("env-some-third-party");
    expect(first).toBe(second);
  });

  it("never assigns a third-party provider to a bundled slot (A–D)", () => {
    // Probe with 50 distinct names and confirm the hash never collides
    // with A/B/C/D, which are reserved for the bundled providers.
    for (let i = 0; i < 50; i++) {
      const name = `env-fictitious-${i}`;
      const color = envProviderCategoryColor(name);
      expect(color).not.toMatch(/category-[abcd]-/);
    }
  });

  it("distributes distinct third-party names across multiple slots", () => {
    const slots = new Set<string>();
    for (let i = 0; i < 20; i++) {
      slots.add(envProviderCategoryColor(`env-third-party-${i}`));
    }
    // With 4 fallback slots and 20 inputs we expect to land in at
    // least 2 different slots — otherwise the hash is degenerate.
    expect(slots.size).toBeGreaterThanOrEqual(2);
  });
});
