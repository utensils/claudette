import { describe, it, expect } from "vitest";

/**
 * Test the font style logic from FontSelect without requiring DOM/React.
 * Mirrors the fontStyle function inside FontSelect.tsx.
 */
const SANS_FALLBACK = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";
const MONO_FALLBACK = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';

function fontStyle(v: string, fallback: string): { fontFamily: string } {
  if (v && v !== "__custom__") return { fontFamily: `"${v}", ${fallback}` };
  return { fontFamily: fallback };
}

describe("FontSelect fontStyle logic", () => {
  describe("sans-serif kind", () => {
    it("named font prepends to fallback stack", () => {
      const style = fontStyle("SF Pro", SANS_FALLBACK);
      expect(style.fontFamily).toBe(`"SF Pro", ${SANS_FALLBACK}`);
    });

    it("empty value (Default) returns fallback stack only", () => {
      const style = fontStyle("", SANS_FALLBACK);
      expect(style.fontFamily).toBe(SANS_FALLBACK);
      expect(style.fontFamily).toContain("Inter");
    });

    it("__custom__ returns fallback stack only", () => {
      const style = fontStyle("__custom__", SANS_FALLBACK);
      expect(style.fontFamily).toBe(SANS_FALLBACK);
    });

    it("font name with spaces is properly quoted", () => {
      const style = fontStyle("Avenir Next", SANS_FALLBACK);
      expect(style.fontFamily.startsWith('"Avenir Next"')).toBe(true);
    });
  });

  describe("monospace kind", () => {
    it("named mono font prepends to mono fallback", () => {
      const style = fontStyle("Fira Code", MONO_FALLBACK);
      expect(style.fontFamily).toBe(`"Fira Code", ${MONO_FALLBACK}`);
    });

    it("empty value returns mono fallback", () => {
      const style = fontStyle("", MONO_FALLBACK);
      expect(style.fontFamily).toBe(MONO_FALLBACK);
      expect(style.fontFamily).toContain("JetBrains Mono");
    });
  });

  describe("ensures no font inheritance leak", () => {
    it("always returns a fontFamily — never undefined", () => {
      // These are the values that caused the Zapfino inheritance bug
      for (const v of ["", "__custom__", "Arial", "Zapfino"]) {
        const style = fontStyle(v, SANS_FALLBACK);
        expect(style.fontFamily).toBeTruthy();
        expect(typeof style.fontFamily).toBe("string");
      }
    });

    it("Default option does NOT contain the selected font name", () => {
      // If user selected Zapfino, the Default option should render in Inter
      const style = fontStyle("", SANS_FALLBACK);
      expect(style.fontFamily).not.toContain("Zapfino");
    });
  });
});
