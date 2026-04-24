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

  it("preserves interior empty lines (not trailing)", () => {
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
    const nbsp = " ";
    expect(trimSelectionTrailingWhitespace(`line${nbsp}`)).toBe(`line${nbsp}`);
  });

  it("drops trailing all-empty lines (selection dragged past end of content)", () => {
    const input = "real content\n   \n\n   \n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("real content\n");
  });

  it("drops trailing empty lines and keeps a single newline when the original ended with one", () => {
    const input = "real content\n\n\n";
    expect(trimSelectionTrailingWhitespace(input)).toBe("real content\n");
  });

  it("drops trailing empty lines without adding a newline when the original had none", () => {
    const input = "real content\n   \n   ";
    expect(trimSelectionTrailingWhitespace(input)).toBe("real content");
  });

  it("returns empty string when the entire selection is whitespace", () => {
    expect(trimSelectionTrailingWhitespace("   \n   \n\n")).toBe("");
  });

  it("preserves leading blank lines (may be intentional spacing)", () => {
    expect(trimSelectionTrailingWhitespace("\n\nafter blank\n")).toBe(
      "\n\nafter blank\n",
    );
  });

  it("drops only trailing empties, not interior ones", () => {
    const input = "top\n\nmiddle\n\nbottom\n\n\n";
    expect(trimSelectionTrailingWhitespace(input)).toBe(
      "top\n\nmiddle\n\nbottom\n",
    );
  });
});
