/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "MessageMarkdown.module.css"),
  "utf-8",
);

/**
 * Regression test for code-block selection stair-step bug.
 *
 * WebKit paints selection highlights across the full line-box width of the
 * selected element's containing block.  Without the properties asserted here,
 * selecting text inside a fenced code block extends the highlight to the
 * full <pre> width and paints "stair-step" tabs above and below the
 * visible code.  The fix requires cooperating rules on <pre> and <code>:
 *
 *   1. <pre> disables user-select so clicks in its padding can't start a
 *      selection that extends to the full <pre> width.
 *   2. <code> re-enables user-select so the text itself remains selectable.
 *   3. <code> uses width: fit-content so its bounding box is only as wide
 *      as the visible text.
 *   4. <code> uses padding: 0 !important so the element rect matches the
 *      visible text bounds — keeps the selection rect tight regardless of
 *      what the highlighter (Shiki, or anything else) emits.
 */

function extractBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "m");
  const match = css.match(re);
  return match?.[1] ?? "";
}

describe("code-block selection CSS (regression for stair-step bug)", () => {
  const preBlock = extractBlock(":where(.body) pre");
  const codeBlock = extractBlock(":where(.body) pre code");

  it("disables user-select on pre to prevent padding-area selections", () => {
    expect(preBlock).toMatch(/user-select:\s*none/);
    expect(preBlock).toMatch(/-webkit-user-select:\s*none/);
  });

  it("re-enables user-select on code so text remains selectable", () => {
    expect(codeBlock).toMatch(/user-select:\s*text/);
    expect(codeBlock).toMatch(/-webkit-user-select:\s*text/);
  });

  it("shrink-wraps code with fit-content to bound selection width", () => {
    expect(codeBlock).toMatch(/width:\s*fit-content/);
    expect(codeBlock).toMatch(/max-width:\s*100%/);
  });

  it("zeroes code padding with !important so selection rect matches text bounds", () => {
    expect(codeBlock).toMatch(/padding:\s*0\s*!important/);
  });

  it("keeps code as display: block so it respects width: fit-content", () => {
    expect(codeBlock).toMatch(/display:\s*block/);
  });
});
