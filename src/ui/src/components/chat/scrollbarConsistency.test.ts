// Cross-surface CSS regression: chat (`OverlayScrollbar`), Monaco
// editor, and the xterm terminal must all draw their scrollbars from
// the same shared tokens (`--scrollbar-size`, `--scrollbar-thumb`,
// `--scrollbar-thumb-hover`, `--radius-sm`, `--scrollbar-edge-inset`).
//
// Why this test exists: each surface has its own CSS module and a
// drive-by tweak in any one of them — say, hard-coding `width: 8px`
// instead of `var(--scrollbar-size)`, or removing the `border-radius`
// rule from MonacoEditor.module.css — would silently let the three
// drift apart again. The bug is invisible at 100% browser zoom but
// reappears the moment the user zooms in or out (overlay scrollbars
// don't scale with zoom; `var()`-sized DOM sliders do). Tests in
// happy-dom can't catch that because happy-dom doesn't lay out CSS;
// the only way to lock the contract is to read the source files and
// pin the tokens.
//
// Update notes (read before editing): if you intentionally change the
// token strategy (e.g., introducing a separate `--chat-scrollbar-size`),
// update both the surface AND this test in the same commit, and call
// out the divergence in the PR description so reviewers know it was
// deliberate.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve from the test file's own URL — `__dirname` is undefined in
// real ESM modules. Vitest currently shims it, but mirroring the
// pattern used by `components/layout/headerAlignment.test.ts` keeps
// this test portable to bare Node and isn't dependent on the shim.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_SRC = join(__dirname, "..", "..");

function readCss(rel: string): string {
  // Strip CSS block comments so a stray `.foo` inside a comment can't
  // shadow the real rule when ruleBody scans for selectors. Without
  // this, a comment like `/* ...like .messages used to. */` matches
  // before the real `.messages { ... }` rule.
  return readFileSync(join(UI_SRC, rel), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
}

function ruleBody(css: string, selector: string): string {
  // Match the literal selector up to the next `{ ... }` block. The
  // `(?![\\w-])` lookahead pins the end of the selector to a non
  // identifier char so `.messages` doesn't accidentally match
  // `.messagesWrapper`. CSS modules don't nest at the top level so a
  // flat `[^}]*` body capture is sufficient.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![\\w-])\\s*[^{]*\\{([^}]*)\\}`);
  const match = css.match(re);
  if (!match) {
    throw new Error(`selector ${selector} not found`);
  }
  return match[1];
}

describe("chat OverlayScrollbar uses the shared scrollbar tokens", () => {
  const css = readCss("components/chat/OverlayScrollbar.module.css");

  it("track width is var(--scrollbar-size) — never a hard-coded pixel value", () => {
    const body = ruleBody(css, ".track");
    expect(body).toMatch(/width:\s*var\(--scrollbar-size\)/);
    // Catch a future drive-by like `width: 8px;` that would silently
    // break the scale-with-zoom contract.
    expect(body).not.toMatch(/width:\s*\d+px/);
  });

  it("track is inset from the wall by --scrollbar-edge-inset to match Monaco/xterm", () => {
    // The 8px gap between the slider and the panel right wall is the
    // visual signature shared by xterm (`.paneRoot { inset: 8px }`)
    // and Monaco (`.host { margin-right: var(--scrollbar-edge-inset) }`).
    // If the chat's track moves to `right: 0` the slider drifts 8px
    // outboard of the other two.
    const body = ruleBody(css, ".track");
    expect(body).toMatch(/right:\s*var\(--scrollbar-edge-inset\)/);
  });

  it("slider thumb uses --scrollbar-thumb and --scrollbar-thumb-hover, with --radius-sm corners", () => {
    const sliderBody = ruleBody(css, ".slider");
    expect(sliderBody).toMatch(/background:\s*var\(--scrollbar-thumb\)/);
    expect(sliderBody).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    // Hover/drag swap to the brighter token. We assert against the file
    // rather than the rule body because the hover/dragging selector is
    // its own rule.
    expect(css).toMatch(
      /\.slider:hover[^}]*background:\s*var\(--scrollbar-thumb-hover\)/s,
    );
    expect(css).toMatch(
      /\.slider\[data-dragging="true"\][^}]*background:\s*var\(--scrollbar-thumb-hover\)/s,
    );
  });
});

describe("ChatPanel.module.css hides the native scrollbar", () => {
  const css = readCss("components/chat/ChatPanel.module.css");
  const body = ruleBody(css, ".messages");

  it("sets scrollbar-width: none so the OS overlay can't render alongside the custom one", () => {
    // If this regresses to `thin` or `auto` the macOS overlay
    // scrollbar paints over the custom slider and the user sees a
    // doubled rail.
    expect(body).toMatch(/scrollbar-width:\s*none/);
  });

  it("hides the WebKit scrollbar via display: none, width: 0, height: 0", () => {
    const wkBody = ruleBody(css, ".messages::-webkit-scrollbar");
    expect(wkBody).toMatch(/display:\s*none/);
    expect(wkBody).toMatch(/width:\s*0/);
    expect(wkBody).toMatch(/height:\s*0/);
  });

  it("retains the right-edge margin so the custom track sits in the same lane Monaco's host uses", () => {
    expect(body).toMatch(
      /margin-right:\s*var\(--scrollbar-edge-inset\)/,
    );
  });
});

describe("MonacoEditor rounds its slider with --radius-sm to match xterm/chat", () => {
  const css = readCss("components/file-viewer/MonacoEditor.module.css");

  it("targets the Monaco scrollbar slider via :global and applies --radius-sm", () => {
    // Monaco's theme schema has no `borderRadius` token for the slider —
    // it ships rectangular by default. Without this rule, the Monaco
    // scrollbar diverges visually from the rounded chat / xterm
    // sliders. The rule must use !important because Monaco reapplies
    // inline width / height / transform on every scroll tick.
    expect(css).toMatch(
      /:global\(\s*\.monaco-scrollable-element\s*>\s*\.scrollbar\s*>\s*\.slider\s*\)/,
    );
    expect(css).toMatch(/border-radius:\s*var\(--radius-sm\)\s*!important/);
  });
});

describe("TerminalPanel xterm slider uses the shared tokens", () => {
  const css = readCss("components/terminal/TerminalPanel.module.css");

  it("xterm slider width is var(--scrollbar-size) — never a literal pixel value", () => {
    // Two rules apply width: the parent `.scrollbar.vertical` and the
    // child `.scrollbar.vertical > .slider`. Both must use the token.
    expect(css).toMatch(
      /\.scrollbar\.vertical\)[\s\S]*?width:\s*var\(--scrollbar-size\)\s*!important/,
    );
    expect(css).toMatch(
      /\.scrollbar\.vertical\s*>\s*\.slider\)[\s\S]*?width:\s*var\(--scrollbar-size\)\s*!important/,
    );
  });

  it("xterm slider background + radius use --scrollbar-thumb / --radius-sm", () => {
    // The selector that styles `.scrollbar > .slider` (no orientation)
    // owns background + border-radius. xterm.js inlines its own
    // background; `!important` is required to win against that.
    expect(css).toMatch(
      /\.scrollbar\s*>\s*\.slider\)[\s\S]*?background:\s*var\(--scrollbar-thumb\)\s*!important/,
    );
    expect(css).toMatch(
      /\.scrollbar\s*>\s*\.slider\)[\s\S]*?border-radius:\s*var\(--radius-sm\)\s*!important/,
    );
  });

  it("xterm slider hover/active swap to --scrollbar-thumb-hover", () => {
    // Mirrors the `.slider:hover` swap on the chat's OverlayScrollbar
    // and Monaco's `scrollbarSlider.hoverBackground` theme color, so
    // hovering produces the same accent on every surface.
    expect(css).toMatch(
      /\.slider:hover[\s\S]*?background:\s*var\(--scrollbar-thumb-hover\)\s*!important/,
    );
    expect(css).toMatch(
      /\.slider\.active[\s\S]*?background:\s*var\(--scrollbar-thumb-hover\)\s*!important/,
    );
  });
});

describe("MonacoEditor passes 8px to Monaco's scrollbar config", () => {
  // This isn't a CSS file — Monaco's scrollbar size is set in JS via the
  // `scrollbar` editor option. Read the source to pin both the
  // vertical/horizontal scrollbar sizes (the rail) and slider sizes
  // (the thumb) so they continue to match `var(--scrollbar-size) = 8px`.
  // If this drifts from 8 the Monaco slider shows up wider/thinner
  // than xterm and chat at 100% zoom.
  const ts = readFileSync(
    join(UI_SRC, "components/file-viewer/MonacoEditor.tsx"),
    "utf8",
  );

  it("Monaco scrollbar sizes are 8 to match var(--scrollbar-size)", () => {
    expect(ts).toMatch(/verticalScrollbarSize:\s*8/);
    expect(ts).toMatch(/verticalSliderSize:\s*8/);
    expect(ts).toMatch(/horizontalScrollbarSize:\s*8/);
    expect(ts).toMatch(/horizontalSliderSize:\s*8/);
  });
});

describe("theme.css scrollbar tokens are defined and rgba-ish", () => {
  const css = readCss("styles/theme.css");

  it("declares --scrollbar-size, --scrollbar-thumb, --scrollbar-thumb-hover, --scrollbar-edge-inset", () => {
    expect(css).toMatch(/--scrollbar-size:\s*8px/);
    expect(css).toMatch(/--scrollbar-edge-inset:\s*8px/);
    expect(css).toMatch(/--scrollbar-thumb:\s*var\(--hover-bg\)/);
    expect(css).toMatch(/--scrollbar-thumb-hover:\s*rgba\(/);
  });
});
