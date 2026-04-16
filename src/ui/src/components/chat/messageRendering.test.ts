import { describe, expect, it } from "vitest";

import { roleClassKey, shouldRenderAsMarkdown } from "./messageRendering";

describe("shouldRenderAsMarkdown", () => {
  it("routes assistant output through the markdown renderer", () => {
    // Agent output is agent-authored markdown (headings, tables, code blocks).
    expect(shouldRenderAsMarkdown("Assistant")).toBe(true);
  });

  it("routes system output through the markdown renderer", () => {
    // System messages emitted by /plan open, /status, setup-script output
    // etc. may contain multi-line markdown that must render as distinct blocks.
    expect(shouldRenderAsMarkdown("System")).toBe(true);
  });

  it("leaves user-authored messages as plain text", () => {
    // Users type literal characters — leading `#`, `*`, backticks — that
    // should NOT be interpreted as markdown syntax in their own prompt.
    expect(shouldRenderAsMarkdown("User")).toBe(false);
  });
});

describe("roleClassKey", () => {
  it("uses the compact pill style for single-line system notifications", () => {
    // One-liners like "Conversation cleared." keep the centered pill look.
    expect(roleClassKey("System", "Conversation cleared.")).toBe("role_System");
    expect(roleClassKey("System", "Model set to sonnet.")).toBe("role_System");
    expect(roleClassKey("System", "")).toBe("role_System");
  });

  it("promotes multi-line system messages to the left-aligned block card", () => {
    // Plan dumps from /plan open, /status multi-line summaries, and
    // setup-script output land on the block variant so markdown headings,
    // lists, and code fences render correctly.
    const planDump = [
      "_Plan file — `/tmp/.claude/plans/x.md`_",
      "",
      "# Plan: do the thing",
      "",
      "- step one",
      "- step two",
    ].join("\n");
    expect(roleClassKey("System", planDump)).toBe("role_System_block");
  });

  it("promotes even a two-line status summary to the block card", () => {
    const status = "Repo: demo\nBranch: main";
    expect(roleClassKey("System", status)).toBe("role_System_block");
  });

  it("keeps assistant and user roles on their canonical class regardless of content shape", () => {
    // Block layout is a System-only concern — Assistant bubbles already have
    // their own layout, and User messages never render markdown anyway.
    expect(roleClassKey("Assistant", "single line")).toBe("role_Assistant");
    expect(roleClassKey("Assistant", "line one\nline two")).toBe(
      "role_Assistant",
    );
    expect(roleClassKey("User", "hello")).toBe("role_User");
    expect(roleClassKey("User", "line one\nline two")).toBe("role_User");
  });

  it("detects any newline character — \\r\\n input would still be promoted", () => {
    // Guard against line-ending differences from pasted content. `includes`
    // on `\n` catches both unix and windows line endings since `\r\n`
    // contains `\n`.
    expect(roleClassKey("System", "header\r\n\r\nbody")).toBe(
      "role_System_block",
    );
  });
});
