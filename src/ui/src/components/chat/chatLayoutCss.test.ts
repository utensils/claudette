// CSS invariants that can't be exercised in happy-dom (which doesn't run
// real layout or apply CSS Modules). Pin them by reading the source CSS
// and asserting the offending properties are present — brittle to
// reformatting, but worth it because both bugs were silent: the DOM
// looked fine, only `getBoundingClientRect` in a real browser revealed
// the collapse / scrollbar.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_DIR = join(__dirname);

function readCss(file: string): string {
  return readFileSync(join(CSS_DIR, file), "utf8");
}

/** Extract the body of a single CSS rule by selector (`.turnEditSummary`).
 *  Greedy match up to the matching closing brace. Throws if not found so
 *  the test fails loudly when a rule is renamed or deleted rather than
 *  silently passing because the search returned an empty string. */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*{([^}]*)}`,
  );
  const match = css.match(re);
  if (!match) throw new Error(`selector ${selector} not found in CSS`);
  return match[1];
}

describe("ChatPanel.module.css invariants", () => {
  // Regression: when `.turnEditSummary` lives inside a flex column whose
  // parent has `overflow: auto` (the messages list), the spec-mandated
  // implicit `min-height: 0` (because the card has its own
  // `overflow: hidden` for rounded corners) shrinks the card to the
  // border height. `scrollHeight` reads ~158px while the rendered box
  // is ~2px — the file list is invisible.
  // See `fix(chat): keep edit summary card from collapsing inside flex column`.
  it("turnEditSummary pins flex-shrink: 0 so the card can't collapse in a flex column", () => {
    const css = readCss("ChatPanel.module.css");
    const body = ruleBody(css, ".turnEditSummary");
    expect(body).toMatch(/flex-shrink:\s*0\s*;/);
    // overflow: hidden is the trigger — verify it's still there so the
    // pairing is intentional and a future drive-by removal of either
    // half is caught.
    expect(body).toMatch(/overflow:\s*hidden\s*;/);
  });

  it("tool-call summaries wrap instead of ellipsizing the command or path", () => {
    const css = readCss("ChatPanel.module.css");
    for (const selector of [".toolSummary", ".agentToolCallSummary", ".inlineEditPath"]) {
      const body = ruleBody(css, selector);
      expect(body).not.toMatch(/text-overflow:\s*ellipsis\s*;/);
      expect(body).toMatch(/white-space:\s*pre-wrap\s*;/);
      expect(body).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    }
  });
});

describe("ThinkingBlock.module.css invariants", () => {
  // Regression: inline thinking (Brink Mode / grouping disabled) lives
  // inside the chat scroller. The default `.content` rule caps the
  // box at 400px and adds an inner scrollbar; inline must not nest a
  // second scroll surface inside the chat scroll. See
  // `fix(chat): keep edit summary card ...` — same commit drops the
  // inline scrollbar.
  it("contentInline resets max-height and overflow so it can't introduce a nested scroll", () => {
    const css = readCss("ThinkingBlock.module.css");
    const body = ruleBody(css, ".contentInline");
    expect(body).toMatch(/max-height:\s*none\s*;/);
    expect(body).toMatch(/overflow-y:\s*visible\s*;/);
  });

  it("default content rule still caps height (sanity — only inline opts out)", () => {
    // Pin that the cap on the default boxed variant isn't accidentally
    // removed. Without it, very long thinking dumps would push the
    // turn footer offscreen.
    const css = readCss("ThinkingBlock.module.css");
    const body = ruleBody(css, ".content");
    expect(body).toMatch(/max-height:\s*\d+px\s*;/);
    expect(body).toMatch(/overflow-y:\s*auto\s*;/);
  });
});
