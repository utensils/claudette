import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../stores/useAppStore";
import {
  adjustUiFontSize,
  clampUiFontSize,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_DEFAULT,
  buildFontOptions,
  resetUiFontSize,
} from "./fontSettings";

const mocks = vi.hoisted(() => ({
  applyUserFonts: vi.fn(),
  setAppSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("./theme", () => ({
  applyUserFonts: mocks.applyUserFonts,
}));

vi.mock("../services/tauri", () => ({
  setAppSetting: mocks.setAppSetting,
}));

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

describe("UI zoom persistence", () => {
  beforeEach(() => {
    mocks.applyUserFonts.mockClear();
    mocks.setAppSetting.mockClear();
    useAppStore.setState({
      fontFamilySans: "",
      fontFamilyMono: "",
      uiFontSize: UI_FONT_SIZE_DEFAULT,
    });
  });

  it("persists keyboard/menu zoom changes to app settings", () => {
    adjustUiFontSize(+1);

    expect(useAppStore.getState().uiFontSize).toBe(UI_FONT_SIZE_DEFAULT + 1);
    expect(mocks.applyUserFonts).toHaveBeenCalledWith("", "", UI_FONT_SIZE_DEFAULT + 1);
    expect(mocks.setAppSetting).toHaveBeenCalledWith(
      "ui_font_size",
      String(UI_FONT_SIZE_DEFAULT + 1),
    );
  });

  it("persists reset zoom to the default UI font size", () => {
    useAppStore.setState({ uiFontSize: 17 });

    resetUiFontSize();

    expect(useAppStore.getState().uiFontSize).toBe(UI_FONT_SIZE_DEFAULT);
    expect(mocks.applyUserFonts).toHaveBeenCalledWith("", "", UI_FONT_SIZE_DEFAULT);
    expect(mocks.setAppSetting).toHaveBeenCalledWith(
      "ui_font_size",
      String(UI_FONT_SIZE_DEFAULT),
    );
  });

  it("does not write settings when zoom is already at the clamp boundary", () => {
    useAppStore.setState({ uiFontSize: UI_FONT_SIZE_MAX });

    adjustUiFontSize(+1);

    expect(useAppStore.getState().uiFontSize).toBe(UI_FONT_SIZE_MAX);
    expect(mocks.applyUserFonts).not.toHaveBeenCalled();
    expect(mocks.setAppSetting).not.toHaveBeenCalled();
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

  it("both lists contain all non-hidden fonts", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    const sansValues = sans.map((o) => o.value);
    const monoValues = mono.map((o) => o.value);
    const visibleFonts = systemFonts.filter((n) => !n.startsWith(".") && !n.startsWith("#"));
    for (const name of visibleFonts) {
      expect(sansValues).toContain(name);
      expect(monoValues).toContain(name);
    }
  });

  it("sans list orders sans-group fonts before mono-group fonts", () => {
    const { sans } = buildFontOptions(systemFonts);
    const fontEntries = sans.filter((o) => o.group);
    const firstMonoIdx = fontEntries.findIndex((o) => o.group === "mono");
    const lastSansIdx = fontEntries.map((o) => o.group).lastIndexOf("sans");
    expect(firstMonoIdx).not.toBe(-1);
    expect(lastSansIdx).not.toBe(-1);
    expect(lastSansIdx).toBeLessThan(firstMonoIdx);
  });

  it("mono list orders mono-group fonts before sans-group fonts", () => {
    const { mono } = buildFontOptions(systemFonts);
    const fontEntries = mono.filter((o) => o.group);
    const firstSansIdx = fontEntries.findIndex((o) => o.group === "sans");
    const lastMonoIdx = fontEntries.map((o) => o.group).lastIndexOf("mono");
    expect(firstSansIdx).not.toBe(-1);
    expect(lastMonoIdx).not.toBe(-1);
    expect(lastMonoIdx).toBeLessThan(firstSansIdx);
  });

  it("tags fonts with correct group field", () => {
    const { sans } = buildFontOptions(systemFonts);
    const arial = sans.find((o) => o.value === "Arial");
    const firaCode = sans.find((o) => o.value === "Fira Code");
    expect(arial?.group).toBe("sans");
    expect(firaCode?.group).toBe("mono");
  });

  it("Default and Custom entries have no group field", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    expect(sans[0].group).toBeUndefined();
    expect(sans[sans.length - 1].group).toBeUndefined();
    expect(mono[0].group).toBeUndefined();
    expect(mono[mono.length - 1].group).toBeUndefined();
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
    const { sans } = buildFontOptions(systemFonts);
    const courierNew = sans.find((o) => o.value === "Courier New");
    expect(courierNew?.group).toBe("mono");
  });

  it("classifies Inconsolata as mono", () => {
    const { sans } = buildFontOptions(systemFonts);
    const inconsolata = sans.find((o) => o.value === "Inconsolata");
    expect(inconsolata?.group).toBe("mono");
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
    const { sans } = buildFontOptions(monoNames);
    for (const name of monoNames) {
      const opt = sans.find((o) => o.value === name);
      expect(opt?.group).toBe("mono");
    }
  });

  it("uses font name as both value and label", () => {
    const { sans } = buildFontOptions(["Helvetica Neue"]);
    const opt = sans.find((o) => o.value === "Helvetica Neue");
    expect(opt).toEqual({ value: "Helvetica Neue", label: "Helvetica Neue", group: "sans" });
  });

  it("preserves input order within each group", () => {
    const { sans } = buildFontOptions(["Zapfino", "Arial", "Baskerville"]);
    const sansGroupValues = sans.filter((o) => o.group === "sans").map((o) => o.value);
    expect(sansGroupValues).toEqual(["Zapfino", "Arial", "Baskerville"]);
  });

  it("classifies macOS-specific mono fonts", () => {
    const { sans } = buildFontOptions(["Monaco", "Andale Mono", "PT Mono"]);
    for (const name of ["Monaco", "Andale Mono", "PT Mono"]) {
      expect(sans.find((o) => o.value === name)?.group).toBe("mono");
    }
  });

  it("classifies modern mono fonts", () => {
    const { sans } = buildFontOptions([
      "Monaspace Neon", "Maple Mono", "Intel One Mono", "0xProto", "Commit Mono",
    ]);
    for (const name of ["Monaspace Neon", "Maple Mono", "Intel One Mono", "0xProto", "Commit Mono"]) {
      expect(sans.find((o) => o.value === name)?.group).toBe("mono");
    }
  });

  it("does not misclassify 'Monotype Corsiva' as mono", () => {
    const { sans } = buildFontOptions(["Monotype Corsiva"]);
    expect(sans.find((o) => o.value === "Monotype Corsiva")?.group).toBe("sans");
  });

  it("both lists have same length", () => {
    const { sans, mono } = buildFontOptions(systemFonts);
    expect(sans.length).toBe(mono.length);
  });

  it("handles duplicate font names in input", () => {
    const { sans } = buildFontOptions(["Arial", "Arial", "Helvetica"]);
    const arialCount = sans.filter((o) => o.value === "Arial").length;
    expect(arialCount).toBe(2);
  });
});
