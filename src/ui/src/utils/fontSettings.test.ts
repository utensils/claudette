import { describe, it, expect } from "vitest";
import {
  clampUiFontSize,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_DEFAULT,
  buildFontOptions,
} from "./fontSettings";

describe("clampUiFontSize", () => {
  it("returns the value when in range", () => {
    expect(clampUiFontSize(15)).toBe(15);
  });

  it("clamps at minimum", () => {
    expect(clampUiFontSize(5)).toBe(UI_FONT_SIZE_MIN);
  });

  it("clamps at maximum", () => {
    expect(clampUiFontSize(30)).toBe(UI_FONT_SIZE_MAX);
  });

  it("handles boundary values", () => {
    expect(clampUiFontSize(UI_FONT_SIZE_MIN)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(UI_FONT_SIZE_MAX)).toBe(UI_FONT_SIZE_MAX);
  });

  it("returns default when given default", () => {
    expect(clampUiFontSize(UI_FONT_SIZE_DEFAULT)).toBe(UI_FONT_SIZE_DEFAULT);
  });
});

describe("buildFontOptions", () => {
  const systemFonts = [
    "Arial",
    "SF Pro",
    "Roboto",
    "Fira Code",
    "JetBrains Mono",
    "Source Code Pro",
    "Inconsolata",
    ".Hidden Font",
    "Noto Sans",
    "Menlo",
    "Courier New",
    "SF Mono",
  ];

  it("splits fonts into sans and mono lists", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    const sansValues = sans.map((o) => o.value);
    const monoValues = mono.map((o) => o.value);
    expect(sansValues).toContain("Arial");
    expect(sansValues).toContain("SF Pro");
    expect(sansValues).toContain("Roboto");
    expect(monoValues).toContain("Fira Code");
    expect(monoValues).toContain("JetBrains Mono");
    expect(monoValues).toContain("Source Code Pro");
    expect(monoValues).toContain("SF Mono");
    expect(monoValues).toContain("Menlo");
  });

  it("has default entries with empty value", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    expect(sans[0]).toEqual({ value: "", label: "Default (Inter)" });
    expect(mono[0]).toEqual({ value: "", label: "Default (JetBrains Mono)" });
  });

  it("has Custom... entry at the end of each list", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    expect(sans[sans.length - 1]).toEqual({ value: "__custom__", label: "Custom..." });
    expect(mono[mono.length - 1]).toEqual({ value: "__custom__", label: "Custom..." });
  });

  it("filters out hidden fonts starting with dot", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    const allValues = [...sans, ...mono].map((o) => o.value);
    expect(allValues).not.toContain(".Hidden Font");
  });

  it("handles empty input", () => {
    const { sans, mono } = buildFontOptions([]);
    expect(sans.length).toBe(2); // Default + Custom
    expect(mono.length).toBe(2);
  });

  it("classifies Courier New as mono", () => {
    const { mono } = buildFontOptions(systemFonts);
    expect(mono.map((o) => o.value)).toContain("Courier New");
  });

  it("classifies Inconsolata as mono", () => {
    const { mono } = buildFontOptions(systemFonts);
    expect(mono.map((o) => o.value)).toContain("Inconsolata");
  });

  it("does not put sans fonts in mono list", () => {
    const { mono } = buildFontOptions(systemFonts);
    const monoValues = mono.map((o) => o.value);
    expect(monoValues).not.toContain("Arial");
    expect(monoValues).not.toContain("SF Pro");
    expect(monoValues).not.toContain("Noto Sans");
  });

  it("filters out fonts starting with #", () => {
    const { sans, mono } = buildFontOptions(["#Internal", "Arial"]);
    const allValues = [...sans, ...mono].map((o) => o.value);
    expect(allValues).not.toContain("#Internal");
    expect(allValues).toContain("Arial");
  });

  it("classifies common mono font names correctly", () => {
    const monoNames = [
      "Hack", "Iosevka", "Victor Mono", "Cascadia Code",
      "Anonymous Pro", "Ubuntu Mono", "Roboto Mono",
      "Liberation Mono", "Droid Sans Mono", "Geist Mono",
    ];
    const { mono } = buildFontOptions(monoNames);
    const monoValues = mono.map((o) => o.value);
    for (const name of monoNames) {
      expect(monoValues).toContain(name);
    }
  });

  it("uses font name as both value and label", () => {
    const { sans } = buildFontOptions(["Helvetica Neue"]);
    const opt = sans.find((o) => o.value === "Helvetica Neue");
    expect(opt).toEqual({ value: "Helvetica Neue", label: "Helvetica Neue" });
  });

  it("preserves input order within each list", () => {
    const { sans } = buildFontOptions(["Zapfino", "Arial", "Baskerville"]);
    const values = sans.map((o) => o.value).filter((v) => v && v !== "__custom__");
    expect(values).toEqual(["Zapfino", "Arial", "Baskerville"]);
  });

  it("classifies macOS-specific mono fonts", () => {
    const { mono } = buildFontOptions(["Monaco", "Andale Mono", "PT Mono"]);
    const values = mono.map((o) => o.value);
    expect(values).toContain("Monaco");
    expect(values).toContain("Andale Mono");
    expect(values).toContain("PT Mono");
  });

  it("classifies modern mono fonts", () => {
    const { mono } = buildFontOptions([
      "Monaspace Neon", "Maple Mono", "Intel One Mono", "0xProto", "Commit Mono",
    ]);
    const values = mono.map((o) => o.value);
    for (const name of ["Monaspace Neon", "Maple Mono", "Intel One Mono", "0xProto", "Commit Mono"]) {
      expect(values).toContain(name);
    }
  });

  it("does not misclassify 'Monotype Corsiva' as mono", () => {
    // "Monotype" contains "mono" but \bmono\b won't match because
    // the trailing "t" is a word character (no boundary after "mono").
    const { sans } = buildFontOptions(["Monotype Corsiva"]);
    expect(sans.map((o) => o.value)).toContain("Monotype Corsiva");
  });

  it("handles duplicate font names in input", () => {
    const { sans } = buildFontOptions(["Arial", "Arial", "Helvetica"]);
    const arialCount = sans.filter((o) => o.value === "Arial").length;
    // buildFontOptions does not deduplicate — that's the backend's job
    expect(arialCount).toBe(2);
  });
});
