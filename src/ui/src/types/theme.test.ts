import { describe, it, expect } from "vitest";
import type { StructuredTheme, LegacyTheme } from "./theme";
import { normalizeTheme, isStructuredTheme } from "./theme";

describe("isStructuredTheme", () => {
  it("returns true for structured themes with manifest + tokens", () => {
    const theme: StructuredTheme = {
      manifest: { id: "a", name: "A" },
      tokens: { color: { "accent-primary": "#f00" } },
    };
    expect(isStructuredTheme(theme)).toBe(true);
  });

  it("returns false for legacy flat themes", () => {
    const theme: LegacyTheme = {
      id: "b",
      name: "B",
      colors: { "accent-primary": "#0f0" },
    };
    expect(isStructuredTheme(theme)).toBe(false);
  });

  it("returns false when manifest is missing", () => {
    // Bad input — lean on runtime typing to simulate a malformed theme.
    const bad = { tokens: { color: {} } } as unknown as StructuredTheme;
    expect(isStructuredTheme(bad)).toBe(false);
  });
});

describe("normalizeTheme (structured shape)", () => {
  const theme: StructuredTheme = {
    manifest: {
      id: "forest",
      name: "Forest",
      author: "Jane",
      description: "Mossy",
      version: "1.0.0",
      scheme: "dark",
    },
    tokens: {
      color: {
        "color-scheme": "dark",
        "accent-primary": "#8fbc8f",
        "app-bg": "#0a120a",
      },
      typography: {
        "font-sans": "Inter, sans-serif",
        "font-size-base": "13px",
      },
      radius: {
        "radius-md": "8px",
      },
    },
  };

  it("flattens grouped tokens into a single map", () => {
    const { tokens } = normalizeTheme(theme);
    expect(tokens["accent-primary"]).toBe("#8fbc8f");
    expect(tokens["font-size-base"]).toBe("13px");
    expect(tokens["radius-md"]).toBe("8px");
    expect(tokens["app-bg"]).toBe("#0a120a");
  });

  it("surfaces manifest metadata", () => {
    const meta = normalizeTheme(theme);
    expect(meta.id).toBe("forest");
    expect(meta.name).toBe("Forest");
    expect(meta.author).toBe("Jane");
    expect(meta.description).toBe("Mossy");
    expect(meta.scheme).toBe("dark");
  });

  it("omits group prefix from token keys (accent-primary, not color-accent-primary)", () => {
    const { tokens } = normalizeTheme(theme);
    expect("color-accent-primary" in tokens).toBe(false);
    expect("accent-primary" in tokens).toBe(true);
  });

  it("last-writer-wins when two groups declare the same key", () => {
    const dup: StructuredTheme = {
      manifest: { id: "d", name: "D" },
      tokens: {
        a: { shared: "first" },
        b: { shared: "second" },
      },
    };
    const { tokens } = normalizeTheme(dup);
    // Object.values order is insertion order — second group wins.
    expect(tokens.shared).toBe("second");
  });
});

describe("normalizeTheme (legacy shape)", () => {
  const theme: LegacyTheme = {
    id: "old",
    name: "Old",
    author: "Bob",
    colors: {
      "color-scheme": "light",
      "accent-primary": "#112233",
    },
  };

  it("surfaces flat metadata", () => {
    const meta = normalizeTheme(theme);
    expect(meta.id).toBe("old");
    expect(meta.name).toBe("Old");
    expect(meta.author).toBe("Bob");
  });

  it("returns the colors map directly as tokens", () => {
    const { tokens } = normalizeTheme(theme);
    expect(tokens["accent-primary"]).toBe("#112233");
  });

  it("infers scheme from color-scheme token when manifest is absent", () => {
    expect(normalizeTheme(theme).scheme).toBe("light");
  });

  it("defaults to dark when no scheme is declared", () => {
    const bare: LegacyTheme = {
      id: "bare",
      name: "Bare",
      colors: { "accent-primary": "#f00" },
    };
    expect(normalizeTheme(bare).scheme).toBe("dark");
  });
});

describe("normalizeTheme scheme detection", () => {
  it("structured manifest.scheme wins over token color-scheme", () => {
    const mixed: StructuredTheme = {
      manifest: { id: "m", name: "M", scheme: "dark" },
      tokens: { color: { "color-scheme": "light" } },
    };
    expect(normalizeTheme(mixed).scheme).toBe("dark");
  });

  it("structured theme falls back to token color-scheme when manifest omits it", () => {
    const t: StructuredTheme = {
      manifest: { id: "m", name: "M" },
      tokens: { color: { "color-scheme": "light" } },
    };
    expect(normalizeTheme(t).scheme).toBe("light");
  });

  it("structured theme defaults to dark when nothing declares a scheme", () => {
    const t: StructuredTheme = {
      manifest: { id: "m", name: "M" },
      tokens: { color: { "accent-primary": "#fff" } },
    };
    expect(normalizeTheme(t).scheme).toBe("dark");
  });
});
