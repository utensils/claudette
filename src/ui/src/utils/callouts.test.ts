import { describe, it, expect } from "vitest";
import { preprocessCallouts } from "./callouts";

/** Box-drawing rule of the length Claude actually emits. */
const RULE = "─".repeat(49);
const HEADER_RULE = "─".repeat(45);

describe("preprocessCallouts — inline-backtick form", () => {
  it("converts a complete backtick-wrapped callout to a styled block", () => {
    const out = preprocessCallouts(
      `\`★ Insight ${HEADER_RULE}\`\nWorktrees are cheap.\n\`${RULE}\``,
    );
    expect(out).toContain('<div class="cc-callout">');
    expect(out).toContain(
      '<div class="cc-callout-header"><span class="cc-callout-icon">★</span> Insight</div>',
    );
    expect(out).toContain("Worktrees are cheap.");
    expect(out).toContain("</div>");
  });

  it("keeps a label without a leading icon intact", () => {
    const out = preprocessCallouts(
      `\`Warning ${HEADER_RULE}\`\nBe careful.\n\`${RULE}\``,
    );
    expect(out).toContain('<div class="cc-callout-header">Warning</div>');
    expect(out).not.toContain("cc-callout-icon");
  });

  it("promotes an orphaned header when no closing rule arrived yet", () => {
    const out = preprocessCallouts(`\`★ Insight ${HEADER_RULE}\`\nStill streaming`);
    expect(out).toContain(
      '<div class="cc-callout-header"><span class="cc-callout-icon">★</span> Insight</div>',
    );
    expect(out).not.toContain('<div class="cc-callout">');
  });

  it("turns an orphaned closing rule into a horizontal rule", () => {
    const out = preprocessCallouts(`Some prose.\n\`${RULE}\``);
    expect(out).toContain('<hr class="cc-callout-rule" />');
  });
});

describe("preprocessCallouts — bare-lines form", () => {
  it("converts standalone rule lines to a styled block", () => {
    const out = preprocessCallouts(
      `★ Insight ${HEADER_RULE}\nNo backticks here.\n${RULE}`,
    );
    expect(out).toContain('<div class="cc-callout">');
    expect(out).toContain("No backticks here.");
  });

  it("leaves an indented-code-block callout alone", () => {
    const src = [
      "Example output:",
      "",
      `    ★ Insight ${HEADER_RULE}`,
      "    indented sample",
      `    ${RULE}`,
    ].join("\n");
    expect(preprocessCallouts(src)).toBe(src);
  });
});

describe("preprocessCallouts — fenced code blocks", () => {
  it("unwraps a bare fence whose whole body is a callout", () => {
    const src = [
      "It's inverted: the fix creates the flaw it claims to remove.",
      "",
      "```",
      `★ Insight ${HEADER_RULE}`,
      "This is the classic mock-sentinel pattern, and it reads as a bug",
      'to anyone who scans for "assertion matches input."',
      RULE,
      "```",
      "",
      "Two smaller things: ...",
    ].join("\n");

    const out = preprocessCallouts(src);
    // The regression: HTML source leaking into a code block.
    expect(out).not.toContain("```");
    expect(out).toContain('<div class="cc-callout">');
    expect(out).toContain(
      '<div class="cc-callout-header"><span class="cc-callout-icon">★</span> Insight</div>',
    );
    expect(out).toContain("This is the classic mock-sentinel pattern");
    expect(out).toContain("Two smaller things: ...");
  });

  it("unwraps a fence padded with blank lines around the callout", () => {
    const out = preprocessCallouts(
      ["```", "", `★ Insight ${HEADER_RULE}`, "Padded.", RULE, "", "```"].join("\n"),
    );
    expect(out).toContain('<div class="cc-callout">');
    expect(out).toContain("Padded.");
  });

  it("leaves a language-tagged fence untouched", () => {
    const src = [
      "```text",
      `★ Insight ${HEADER_RULE}`,
      "Shown verbatim on purpose.",
      RULE,
      "```",
    ].join("\n");
    expect(preprocessCallouts(src)).toBe(src);
  });

  it("leaves a fence that mixes a callout with other content untouched", () => {
    const src = [
      "```",
      "$ claudette ws list",
      `★ Insight ${HEADER_RULE}`,
      "Part of a larger sample.",
      RULE,
      "```",
    ].join("\n");
    expect(preprocessCallouts(src)).toBe(src);
  });

  it("does not rewrite callout syntax inside an ordinary code sample", () => {
    const src = [
      "Here is how the raw output looks:",
      "",
      "```",
      "some code",
      `★ Insight ${HEADER_RULE}`,
      "more code",
      "```",
    ].join("\n");
    expect(preprocessCallouts(src)).toBe(src);
  });

  it("handles tilde fences", () => {
    const src = ["~~~", `★ Insight ${HEADER_RULE}`, "Tilde-fenced.", RULE, "~~~"].join(
      "\n",
    );
    const out = preprocessCallouts(src);
    expect(out).toContain('<div class="cc-callout">');
    expect(out).not.toContain("~~~");
  });

  it("leaves an unterminated fence alone", () => {
    const src = ["```", `★ Insight ${HEADER_RULE}`, "Still streaming in"].join("\n");
    expect(preprocessCallouts(src)).toBe(src);
  });

  it("does not let a callout match span a fence boundary", () => {
    const src = [
      `\`★ Insight ${HEADER_RULE}\``,
      "",
      "```",
      "code in between",
      "```",
      "",
      `\`${RULE}\``,
    ].join("\n");
    const out = preprocessCallouts(src);
    // Fence survives verbatim; the two orphans degrade independently.
    expect(out).toContain("```\ncode in between\n```");
    expect(out).toContain('<div class="cc-callout-header">');
    expect(out).toContain('<hr class="cc-callout-rule" />');
  });
});

describe("preprocessCallouts — pass-through", () => {
  it("returns text with no callouts unchanged", () => {
    const src = "Just a paragraph.\n\n- a list item\n- another\n\n```js\nconst a = 1;\n```\n";
    expect(preprocessCallouts(src)).toBe(src);
  });

  it("preserves trailing newlines", () => {
    expect(preprocessCallouts("hello\n\n")).toBe("hello\n\n");
  });

  it("handles an empty string", () => {
    expect(preprocessCallouts("")).toBe("");
  });
});
