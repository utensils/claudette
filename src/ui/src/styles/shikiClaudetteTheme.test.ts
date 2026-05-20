// Integration test: build the Claudette Shiki theme, load a small set of
// grammars, and verify the highlighter actually emits `style="color:
// var(--syntax-*)"` spans. This guards against a class of silent
// regression Copilot flagged: Shiki could change its theme normalization
// to reject non-hex foreground values in a future release, which would
// disable our syntax coloring entirely while the unit-mocked highlighter
// tests stay green.

import { describe, expect, it } from "vitest";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import {
  buildClaudetteShikiTheme,
  CLAUDETTE_SHIKI_THEME_NAME,
} from "./shikiClaudetteTheme";

describe("Claudette Shiki theme — Shiki integration", () => {
  it("highlights real code and emits var(--syntax-*) color values in inline styles", async () => {
    const hl = await createHighlighterCore({
      themes: [buildClaudetteShikiTheme()],
      langs: [(await import("@shikijs/langs/typescript")).default],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
    try {
      const html = hl.codeToHtml('const greeting = "hi";', {
        lang: "typescript",
        theme: CLAUDETTE_SHIKI_THEME_NAME,
      });

      // Shiki passes the foreground value verbatim into a `color:` rule.
      // If a future normalization step strips CSS function-call values,
      // this assertion fires before users notice gray code blocks.
      expect(html).toContain("var(--syntax-");

      // At least one token-group var should show up for this snippet:
      // `const` (keyword) and the string literal both have non-default
      // foregrounds in our scope map.
      expect(html).toMatch(/var\(--syntax-(keyword|string|operator|variable)\)/);
    } finally {
      hl.dispose();
    }
  });

  it("uses var(--app-bg) and var(--text-primary) for the editor surface", () => {
    const theme = buildClaudetteShikiTheme();
    expect(theme.colors).toBeDefined();
    expect(theme.colors?.["editor.background"]).toBe("var(--app-bg)");
    expect(theme.colors?.["editor.foreground"]).toBe("var(--text-primary)");
  });

  it("registers theme settings with var(--syntax-*) foregrounds (not hex literals)", () => {
    const theme = buildClaudetteShikiTheme();
    expect(theme.settings).toBeDefined();
    expect(theme.settings!.length).toBeGreaterThan(0);
    for (const rule of theme.settings!) {
      // Every rule that sets a foreground must use a CSS var, not a hex,
      // otherwise per-theme adaptation breaks.
      const fg = rule.settings?.foreground;
      if (fg) {
        expect(fg).toMatch(/^var\(--syntax-/);
      }
    }
  });
});
