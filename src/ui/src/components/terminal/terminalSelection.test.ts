import { describe, it, expect } from "vitest";
import { trimSelectionTrailingWhitespace } from "./terminalSelection";

describe("trimSelectionTrailingWhitespace", () => {
  it("strips trailing spaces from short lines in a multi-line selection", () => {
    const input = "short line   \nlonger line with more content\nmid    \n";
    const output = trimSelectionTrailingWhitespace(input);
    expect(output).toBe("short line\nlonger line with more content\nmid\n");
  });

  it("leaves single-line selections unchanged when they have no trailing whitespace", () => {
    expect(trimSelectionTrailingWhitespace("hello world")).toBe("hello world");
  });

  it("strips trailing spaces on a single-line selection", () => {
    expect(trimSelectionTrailingWhitespace("hello world    ")).toBe("hello world");
  });

  it("strips trailing tabs as well as spaces", () => {
    expect(trimSelectionTrailingWhitespace("line\t\t ")).toBe("line");
  });

  it("preserves leading whitespace and interior whitespace", () => {
    expect(trimSelectionTrailingWhitespace("  indented\t  content  ")).toBe(
      "  indented\t  content",
    );
  });

  it("preserves empty lines (an empty line stays empty, not removed)", () => {
    const input = "line one\n\nline three";
    expect(trimSelectionTrailingWhitespace(input)).toBe("line one\n\nline three");
  });

  it("collapses a line of only spaces into an empty line", () => {
    expect(trimSelectionTrailingWhitespace("a\n    \nb")).toBe("a\n\nb");
  });

  it("handles an empty selection", () => {
    expect(trimSelectionTrailingWhitespace("")).toBe("");
  });

  it("does not touch non-ASCII whitespace (e.g. NBSP)", () => {
    // Non-breaking space is semantically meaningful in terminal output
    // (e.g. prompts). Only strip regular spaces and tabs.
    const nbsp = " ";
    expect(trimSelectionTrailingWhitespace(`line${nbsp}`)).toBe(`line${nbsp}`);
  });
});
