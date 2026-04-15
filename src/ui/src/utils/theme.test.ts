import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

afterAll(() => {
  vi.unstubAllGlobals();
});

/**
 * vitest runs without a DOM, so we shim `document.documentElement.style`
 * with a Map-backed fake that supports getPropertyValue / setProperty.
 */
const styleMap = new Map<string, string>();
const fakeStyle = {
  getPropertyValue: (name: string) => styleMap.get(name) ?? "",
  setProperty: (name: string, value: string) => { styleMap.set(name, value); },
  removeProperty: (name: string) => { styleMap.delete(name); },
  get fontSize() { return styleMap.get("font-size") ?? ""; },
  set fontSize(v: string) { styleMap.set("font-size", v); },
  get cssText() { return ""; },
  set cssText(_v: string) { styleMap.clear(); },
};

vi.stubGlobal("document", {
  documentElement: { style: fakeStyle },
  getElementById: () => null,
  createElement: () => ({ rel: "", href: "", id: "" }),
  head: { appendChild: () => {} },
});

// Import AFTER the global stub so the module sees our fake document.
const { applyUserFonts, clearUserFont, DEFAULT_SANS_STACK, DEFAULT_MONO_STACK } =
  await import("./theme");

describe("applyUserFonts", () => {
  beforeEach(() => {
    styleMap.clear();
  });

  it("sets zoom level based on font size (base 13px)", () => {
    applyUserFonts("", "", 16);
    const zoom = parseFloat(styleMap.get("zoom") ?? "0");
    expect(zoom).toBeCloseTo(16 / 13, 2);
  });

  it("zoom is 1.0 at default size 13px", () => {
    applyUserFonts("", "", 13);
    const zoom = parseFloat(styleMap.get("zoom") ?? "0");
    expect(zoom).toBeCloseTo(1.0, 2);
  });

  it("sets --font-sans when non-empty", () => {
    applyUserFonts("Roboto", "", 13);
    const val = styleMap.get("--font-sans") ?? "";
    expect(val).toContain("Roboto");
    expect(val).toContain("Inter");
  });

  it("does not touch --font-sans when empty (preserves theme value)", () => {
    styleMap.set("--font-sans", "ThemeFont");
    applyUserFonts("", "", 13);
    expect(styleMap.get("--font-sans")).toBe("ThemeFont");
  });

  it("sets --font-mono when non-empty", () => {
    applyUserFonts("", "Fira Code", 13);
    const val = styleMap.get("--font-mono") ?? "";
    expect(val).toContain("Fira Code");
    expect(val).toContain("JetBrains Mono");
  });

  it("does not touch --font-mono when empty (preserves theme value)", () => {
    styleMap.set("--font-mono", "MonoTheme");
    applyUserFonts("", "", 13);
    expect(styleMap.get("--font-mono")).toBe("MonoTheme");
  });

  it("applies both fonts simultaneously", () => {
    applyUserFonts("Avenir Next", "SF Mono", 15);
    expect(styleMap.get("--font-sans")).toContain("Avenir Next");
    expect(styleMap.get("--font-mono")).toContain("SF Mono");
    expect(parseFloat(styleMap.get("zoom") ?? "0")).toBeCloseTo(15 / 13, 2);
  });
});

describe("font stack constants", () => {
  it("DEFAULT_SANS_STACK contains Inter", () => {
    expect(DEFAULT_SANS_STACK).toContain("Inter");
  });

  it("DEFAULT_MONO_STACK contains JetBrains Mono", () => {
    expect(DEFAULT_MONO_STACK).toContain("JetBrains Mono");
  });
});

describe("clearUserFont", () => {
  beforeEach(() => {
    styleMap.clear();
  });

  it("removes --font-sans inline override", () => {
    styleMap.set("--font-sans", '"SF Pro", fallback');
    clearUserFont("font-sans");
    expect(styleMap.has("--font-sans")).toBe(false);
  });

  it("removes --font-mono inline override", () => {
    styleMap.set("--font-mono", '"Fira Code", fallback');
    clearUserFont("font-mono");
    expect(styleMap.has("--font-mono")).toBe(false);
  });

  it("is a no-op when property does not exist", () => {
    clearUserFont("font-sans");
    expect(styleMap.has("--font-sans")).toBe(false);
  });

  it("does not affect other properties", () => {
    styleMap.set("--font-sans", "SomeFont");
    styleMap.set("--font-mono", "SomeMono");
    clearUserFont("font-sans");
    expect(styleMap.has("--font-sans")).toBe(false);
    expect(styleMap.get("--font-mono")).toBe("SomeMono");
  });
});

describe("applyUserFonts + clearUserFont round-trip", () => {
  beforeEach(() => {
    styleMap.clear();
  });

  it("set then clear restores to empty state", () => {
    applyUserFonts("Roboto", "Fira Code", 16);
    expect(styleMap.get("--font-sans")).toContain("Roboto");
    expect(styleMap.get("--font-mono")).toContain("Fira Code");

    clearUserFont("font-sans");
    clearUserFont("font-mono");
    expect(styleMap.has("--font-sans")).toBe(false);
    expect(styleMap.has("--font-mono")).toBe(false);
    // zoom persists
    expect(styleMap.has("zoom")).toBe(true);
  });
});
