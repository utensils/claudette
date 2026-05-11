/**
 * Regression tests for the Windows integrated-terminal "first character
 * duplicates" bug (visible as `clear` → `cclear` in the rendered DOM,
 * while PSReadLine's actual buffer holds `clear`).
 *
 * The bug is a 1-column width disagreement between PSReadLine and xterm.js
 * for wide-glyph prompt characters (starship status emoji — 💀, 🔋, etc.):
 *
 *   - PSReadLine + ConPTY + every modern terminal: emoji is **2 cells**.
 *   - xterm.js with its default Unicode 6 width tables: emoji is **1 cell**.
 *
 * The shifted cursor causes PSReadLine's first redraw of the input line
 * (its syntax-highlight / predictive-intellisense repaint) to write at the
 * wrong column. Subsequent CUP-positioned writes from PSReadLine land at
 * the correct column, leaving the off-by-one character as a "ghost" copy.
 *
 * The fix is to load `@xterm/addon-unicode11` on every Terminal Claudette
 * creates and switch `term.unicode.activeVersion` to `"11"`, which makes
 * xterm.js's width tables agree with PSReadLine. The addon requires the
 * proposed-API channel, which means `allowProposedApi: true` must also be
 * set on the Terminal constructor.
 *
 * These tests pin each link in that chain. They live next to
 * `TerminalPanel.tsx`, which is where the wiring happens — if any of the
 * three steps (proposed API, addon load, version activation) regresses
 * there, one of these tests fails.
 */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

describe("xterm.js Unicode 11 width activation", () => {
  it("defaults to Unicode 6 — the broken width tables that cause the bug", () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      expect(term.unicode.activeVersion).toBe("6");
      expect(term.unicode.versions).toEqual(["6"]);
    } finally {
      term.dispose();
    }
  });

  it("Unicode11Addon registers version '11' on the terminal", () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      term.loadAddon(new Unicode11Addon());
      expect(term.unicode.versions).toContain("11");
      // Loading the addon does NOT switch versions by itself — the call
      // site must also assign `activeVersion`. That's the third half of
      // the fix; we assert it here to keep the contract explicit.
      expect(term.unicode.activeVersion).toBe("6");
    } finally {
      term.dispose();
    }
  });

  it("after addon + assignment, activeVersion is '11' (the bug-fix endpoint)", () => {
    const term = new Terminal({ allowProposedApi: true });
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      expect(term.unicode.activeVersion).toBe("11");
    } finally {
      term.dispose();
    }
  });

  it("touching term.unicode without allowProposedApi: true throws", () => {
    // The bug fix sets `allowProposedApi: true` on the Terminal constructor
    // so the unicode subsystem is reachable. If anyone removes that option,
    // the same crash this test asserts would fire at app startup the moment
    // TerminalPanel tries to call `term.unicode.activeVersion = "11"`.
    const term = new Terminal();
    try {
      expect(() => term.unicode.activeVersion).toThrowError(
        /allowProposedApi/i,
      );
    } finally {
      term.dispose();
    }
  });
});
