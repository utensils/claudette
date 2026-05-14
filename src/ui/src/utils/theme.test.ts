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

const attrMap = new Map<string, string>();
vi.stubGlobal("document", {
  documentElement: {
    style: fakeStyle,
    setAttribute: (name: string, value: string) => { attrMap.set(name, value); },
    getAttribute: (name: string) => attrMap.get(name) ?? null,
  },
  getElementById: () => null,
  createElement: () => ({ rel: "", href: "", id: "" }),
  head: { appendChild: () => {} },
});
const lsMap = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => lsMap.get(k) ?? null,
  setItem: (k: string, v: string) => { lsMap.set(k, v); },
  removeItem: (k: string) => { lsMap.delete(k); },
  clear: () => { lsMap.clear(); },
});

// Import AFTER the global stub so the module sees our fake document.
const {
  applyUserFonts,
  clearUserFont,
  DEFAULT_SANS_STACK,
  DEFAULT_MONO_STACK,
  getThemeDataAttr,
  cacheThemePreference,
  findTheme,
  detectBase16,
  convertBase16ToClaudette,
} = await import("./theme");
const { DEFAULT_THEME_ID } = await import("../styles/themes");

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

describe("getThemeDataAttr", () => {
  it("returns the built-in theme's own id", () => {
    expect(getThemeDataAttr({ id: "default-dark", name: "", description: "", colors: {} }))
      .toBe("default-dark");
    expect(getThemeDataAttr({ id: "default-light", name: "", description: "", colors: {} }))
      .toBe("default-light");
  });

  it("returns the dark baseline for user themes with dark color-scheme", () => {
    const userTheme = {
      id: "my-user-theme",
      name: "Mine",
      description: "",
      colors: { "color-scheme": "dark" },
    };
    expect(getThemeDataAttr(userTheme)).toBe("default-dark");
  });

  it("returns the light baseline for user themes with light color-scheme", () => {
    const userTheme = {
      id: "my-light-user-theme",
      name: "Light",
      description: "",
      colors: { "color-scheme": "light" },
    };
    expect(getThemeDataAttr(userTheme)).toBe("default-light");
  });

  it("falls back to the dark baseline when color-scheme is missing", () => {
    const userTheme = {
      id: "ambiguous-theme",
      name: "Ambiguous",
      description: "",
      colors: {},
    };
    expect(getThemeDataAttr(userTheme)).toBe("default-dark");
  });
});

describe("cacheThemePreference", () => {
  beforeEach(() => {
    lsMap.clear();
  });

  it("writes mode and per-mode data-theme attrs to localStorage", () => {
    cacheThemePreference("system", "default-dark", "default-light");
    expect(lsMap.get("claudette.theme_mode")).toBe("system");
    expect(lsMap.get("claudette.theme_dark_attr")).toBe("default-dark");
    expect(lsMap.get("claudette.theme_light_attr")).toBe("default-light");
  });

  it("overwrites previously cached values", () => {
    cacheThemePreference("dark", "default-dark", "default-light");
    cacheThemePreference("light", "warm-ember", "default-light");
    expect(lsMap.get("claudette.theme_mode")).toBe("light");
    expect(lsMap.get("claudette.theme_dark_attr")).toBe("warm-ember");
  });

  it("does not throw when localStorage.setItem fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => {},
    });
    expect(() => cacheThemePreference("dark", "default-dark", "default-light")).not.toThrow();
    // Restore the Map-backed stub so later tests can observe writes again.
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => lsMap.get(k) ?? null,
      setItem: (k: string, v: string) => { lsMap.set(k, v); },
      removeItem: (k: string) => { lsMap.delete(k); },
      clear: () => { lsMap.clear(); },
    });
  });
});

describe("findTheme", () => {
  const dark = { id: DEFAULT_THEME_ID, name: "Default Dark", description: "", colors: {} };
  const light = { id: "default-light", name: "Default Light", description: "", colors: {} };
  const custom = { id: "my-custom", name: "Custom", description: "", colors: {} };

  it("returns the matching theme when the requested id exists", () => {
    expect(findTheme([dark, light, custom], "my-custom")).toBe(custom);
  });

  it("falls back to DEFAULT_THEME_ID when the requested id is not found", () => {
    expect(findTheme([dark, light], "nonexistent")).toBe(dark);
  });

  it("falls back to themes[0] when even DEFAULT_THEME_ID is absent", () => {
    expect(findTheme([light, custom], "nonexistent")).toBe(light);
  });

  it("throws when the themes array is empty", () => {
    expect(() => findTheme([], "anything")).toThrow("No themes are available.");
  });
});

// Canonical Base16 "Tomorrow Night" — every key is a 6-char hex without `#`.
// Used across the detection + conversion tests.
const TOMORROW_NIGHT: Record<string, string> = {
  base00: "1d1f21",
  base01: "282a2e",
  base02: "373b41",
  base03: "969896",
  base04: "b4b7b4",
  base05: "c5c8c6",
  base06: "e0e0e0",
  base07: "ffffff",
  base08: "cc6666",
  base09: "de935f",
  base0A: "f0c674",
  base0B: "b5bd68",
  base0C: "8abeb7",
  base0D: "81a2be",
  base0E: "b294bb",
  base0F: "a3685a",
};

describe("detectBase16", () => {
  it("returns true for a complete base16 palette", () => {
    expect(detectBase16({ ...TOMORROW_NIGHT })).toBe(true);
  });

  it("returns true when hexes have a leading # and 3-char shorthand", () => {
    const palette = Object.fromEntries(
      Object.entries(TOMORROW_NIGHT).map(([k, v]) => [k, `#${v}`]),
    );
    palette.base00 = "#000";
    expect(detectBase16(palette)).toBe(true);
  });

  it("returns false when any base key is missing", () => {
    const partial = { ...TOMORROW_NIGHT };
    delete partial.base0F;
    expect(detectBase16(partial)).toBe(false);
  });

  it("returns false when a base value is not a valid hex string", () => {
    const bad = { ...TOMORROW_NIGHT, base05: "not-a-hex" };
    expect(detectBase16(bad)).toBe(false);
  });

  it("returns false when the file also declares Claudette tokens (hybrid is Claudette)", () => {
    const hybrid = { ...TOMORROW_NIGHT, "accent-primary": "#abcdef" };
    expect(detectBase16(hybrid)).toBe(false);
  });

  it("treats any THEMEABLE_VARS token as a Claudette signal, not just accent-primary", () => {
    // A hybrid that overrides only `terminal-bg` (a deep-in-the-list themeable
    // var) must still be treated as Claudette so the author's override survives.
    const hybridTerminal = { ...TOMORROW_NIGHT, "terminal-bg": "#abcdef" };
    expect(detectBase16(hybridTerminal)).toBe(false);

    const hybridSyntax = { ...TOMORROW_NIGHT, "syntax-keyword": "#abcdef" };
    expect(detectBase16(hybridSyntax)).toBe(false);
  });

  it("returns false for a plain Claudette theme without any base keys", () => {
    expect(detectBase16({ "accent-primary": "#e07850", "app-bg": "#1c1815" })).toBe(false);
  });

  it("accepts lowercase base0a–base0f as well as uppercase", () => {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(TOMORROW_NIGHT)) {
      lower[k.toLowerCase()] = v;
    }
    expect(detectBase16(lower)).toBe(true);
  });
});

describe("convertBase16ToClaudette", () => {
  const input = {
    id: "tomorrow-night",
    name: "Tomorrow Night",
    description: "",
    colors: { ...TOMORROW_NIGHT },
  };

  it("maps base16 roles onto Claudette tokens following the canonical spec", () => {
    const out = convertBase16ToClaudette(input).colors;
    expect(out["app-bg"]).toBe("#1d1f21");           // base00
    expect(out["terminal-bg"]).toBe("#1d1f21");      // base00
    expect(out["sidebar-bg"]).toBe("#282a2e");       // base01
    expect(out["text-primary"]).toBe("#c5c8c6");     // base05
    expect(out["accent-error"]).toBe("#cc6666");     // base08
    expect(out["accent-warning"]).toBe("#de935f");   // base09
    expect(out["accent-success"]).toBe("#b5bd68");   // base0B
    expect(out["accent-info"]).toBe("#81a2be");      // base0D
    expect(out["accent-primary"]).toBe("#b294bb");   // base0E
    expect(out["accent-dim"]).toBe("#a3685a");       // base0F
    expect(out["syntax-keyword"]).toBe("#b294bb");   // base0E
    expect(out["syntax-string"]).toBe("#b5bd68");    // base0B
    expect(out["syntax-comment"]).toBe("#969896");   // base03
  });

  it("co-emits -rgb companions for every accent so rgba(var(...),a) keeps working", () => {
    const out = convertBase16ToClaudette(input).colors;
    expect(out["accent-primary-rgb"]).toBe("178, 148, 187");   // base0E
    expect(out["accent-success-rgb"]).toBe("181, 189, 104");   // base0B
    expect(out["accent-error-rgb"]).toBe("204, 102, 102");     // base08
    expect(out["accent-warning-rgb"]).toBe("222, 147, 95");    // base09
    expect(out["accent-info-rgb"]).toBe("129, 162, 190");      // base0D
  });

  it("derives color-scheme=dark from base00 luminance when no variant field", () => {
    const out = convertBase16ToClaudette(input).colors;
    expect(out["color-scheme"]).toBe("dark");
  });

  it("derives color-scheme=light when base00 is bright", () => {
    const light = {
      id: "tomorrow",
      name: "Tomorrow",
      description: "",
      colors: { ...TOMORROW_NIGHT, base00: "ffffff", base01: "f5f5f5" },
    };
    expect(convertBase16ToClaudette(light).colors["color-scheme"]).toBe("light");
  });

  it("prefers an explicit variant field over luminance detection", () => {
    // base00 = dark hex but variant says light — variant wins.
    const tagged = {
      id: "weird",
      name: "Weird",
      description: "",
      colors: { ...TOMORROW_NIGHT, variant: "light" },
    };
    expect(convertBase16ToClaudette(tagged).colors["color-scheme"]).toBe("light");
  });

  it("preserves theme metadata (id, name, author, description)", () => {
    const withMeta = {
      id: "tn",
      name: "Tomorrow Night",
      author: "Chris Kempson",
      description: "Dark theme",
      colors: { ...TOMORROW_NIGHT },
    };
    const out = convertBase16ToClaudette(withMeta);
    expect(out.id).toBe("tn");
    expect(out.name).toBe("Tomorrow Night");
    expect(out.author).toBe("Chris Kempson");
    expect(out.description).toBe("Dark theme");
  });

  it("returns the input unchanged when palette is invalid (defensive)", () => {
    const broken = {
      id: "broken",
      name: "Broken",
      description: "",
      colors: { ...TOMORROW_NIGHT, base05: "not-a-hex" },
    };
    expect(convertBase16ToClaudette(broken)).toBe(broken);
  });

  it("maps text-muted to base04, NOT base06 — base06 is brighter than base05 in dark schemes", () => {
    // Tomorrow Night: base05=#c5c8c6 (default fg), base06=#e0e0e0 (brighter),
    // base04=#b4b7b4 (dimmer). 'muted' must be dimmer than primary.
    const out = convertBase16ToClaudette(input).colors;
    expect(out["text-primary"]).toBe("#c5c8c6");  // base05
    expect(out["text-muted"]).toBe("#b4b7b4");    // base04 (less prominent than primary)
    expect(out["text-dim"]).toBe("#969896");      // base03
  });

  it("emits full -bg/-border/-fg triplets for each status accent so imported palettes don't inherit baseline tints", () => {
    const out = convertBase16ToClaudette(input).colors;
    // success uses base0B (#b5bd68 → 181, 189, 104)
    expect(out["accent-success-bg"]).toBe("rgba(181, 189, 104, 0.10)");
    expect(out["accent-success-border"]).toBe("rgba(181, 189, 104, 0.30)");
    expect(out["accent-success-fg"]).toBe("#b5bd68");
    // error uses base08 (#cc6666 → 204, 102, 102)
    expect(out["accent-error-bg"]).toBe("rgba(204, 102, 102, 0.10)");
    expect(out["accent-error-border"]).toBe("rgba(204, 102, 102, 0.30)");
    // warning uses base09 (#de935f → 222, 147, 95)
    expect(out["accent-warning-bg"]).toBe("rgba(222, 147, 95, 0.10)");
    expect(out["accent-warning-border"]).toBe("rgba(222, 147, 95, 0.30)");
    // info uses base0D (#81a2be → 129, 162, 190)
    expect(out["accent-info-bg"]).toBe("rgba(129, 162, 190, 0.10)");
    expect(out["accent-info-border"]).toBe("rgba(129, 162, 190, 0.30)");
  });

  it("emits secondary + tertiary triplets from base0F and base0E", () => {
    const out = convertBase16ToClaudette(input).colors;
    expect(out["accent-secondary"]).toBe("#a3685a");        // base0F
    expect(out["accent-secondary-bg"]).toBe("rgba(163, 104, 90, 0.10)");
    expect(out["accent-tertiary"]).toBe("#b294bb");         // base0E
    expect(out["accent-tertiary-bg"]).toBe("rgba(178, 148, 187, 0.10)");
  });

  it("accepts a base16 palette using lowercase keys (base0a–base0f)", () => {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(TOMORROW_NIGHT)) {
      lower[k.toLowerCase()] = v;
    }
    const out = convertBase16ToClaudette({
      id: "tomorrow-lower",
      name: "Tomorrow (lowercase)",
      description: "",
      colors: lower,
    }).colors;
    expect(out["accent-success"]).toBe("#b5bd68"); // base0B regardless of case
    expect(out["accent-primary"]).toBe("#b294bb"); // base0E regardless of case
  });
});
