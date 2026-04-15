import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

describe("font settings slice", () => {
  beforeEach(() => {
    useAppStore.setState({
      uiFontSize: 13,
      fontFamilySans: "",
      fontFamilyMono: "",
    });
  });

  it("defaults uiFontSize to 13", () => {
    expect(useAppStore.getState().uiFontSize).toBe(13);
  });

  it("setUiFontSize updates the value", () => {
    useAppStore.getState().setUiFontSize(16);
    expect(useAppStore.getState().uiFontSize).toBe(16);
  });

  it("setFontFamilySans stores font name", () => {
    useAppStore.getState().setFontFamilySans("Roboto");
    expect(useAppStore.getState().fontFamilySans).toBe("Roboto");
  });

  it("setFontFamilyMono stores font name", () => {
    useAppStore.getState().setFontFamilyMono("Fira Code");
    expect(useAppStore.getState().fontFamilyMono).toBe("Fira Code");
  });

  it("empty string resets to theme default", () => {
    useAppStore.getState().setFontFamilySans("Roboto");
    useAppStore.getState().setFontFamilySans("");
    expect(useAppStore.getState().fontFamilySans).toBe("");
  });

  it("font settings are independent", () => {
    useAppStore.getState().setFontFamilySans("Avenir Next");
    useAppStore.getState().setFontFamilyMono("SF Mono");
    useAppStore.getState().setUiFontSize(15);
    expect(useAppStore.getState().fontFamilySans).toBe("Avenir Next");
    expect(useAppStore.getState().fontFamilyMono).toBe("SF Mono");
    expect(useAppStore.getState().uiFontSize).toBe(15);
  });
});

describe("systemFonts slice", () => {
  beforeEach(() => {
    useAppStore.setState({ systemFonts: [] });
  });

  it("defaults to empty array", () => {
    expect(useAppStore.getState().systemFonts).toEqual([]);
  });

  it("setSystemFonts populates the list", () => {
    useAppStore.getState().setSystemFonts(["Arial", "SF Pro", "Fira Code"]);
    expect(useAppStore.getState().systemFonts).toEqual(["Arial", "SF Pro", "Fira Code"]);
  });

  it("setSystemFonts replaces previous list", () => {
    useAppStore.getState().setSystemFonts(["Arial"]);
    useAppStore.getState().setSystemFonts(["Roboto", "Helvetica"]);
    expect(useAppStore.getState().systemFonts).toEqual(["Roboto", "Helvetica"]);
  });
});
