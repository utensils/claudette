import { describe, expect, it } from "vitest";
import { computeLineChanges } from "./gitGutter";

describe("computeLineChanges", () => {
  it("returns [] for identical strings", () => {
    expect(computeLineChanges("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  it("classifies appended lines as add", () => {
    const changes = computeLineChanges("a\n", "a\nb\nc\n");
    expect(changes).toEqual([
      { line: 2, kind: "add" },
      { line: 3, kind: "add" },
    ]);
  });

  it("classifies a pure removal as delete-above on the line that follows", () => {
    const changes = computeLineChanges("a\nb\nc\n", "a\nc\n");
    // 'b' was removed; the marker sits on the line that now occupies its
    // position (line 2 in the new buffer, which holds 'c').
    expect(changes).toEqual([{ line: 2, kind: "delete-above" }]);
  });

  it("classifies a 1->1 replacement as a single modify line", () => {
    const changes = computeLineChanges("a\nb\nc\n", "a\nB\nc\n");
    expect(changes).toEqual([{ line: 2, kind: "modify" }]);
  });

  it("classifies a 3->5 replacement as 5 modify lines spanning the addition", () => {
    const head = "a\nx1\nx2\nx3\nb\n";
    const buf = "a\ny1\ny2\ny3\ny4\ny5\nb\n";
    const changes = computeLineChanges(head, buf);
    expect(changes).toEqual([
      { line: 2, kind: "modify" },
      { line: 3, kind: "modify" },
      { line: 4, kind: "modify" },
      { line: 5, kind: "modify" },
      { line: 6, kind: "modify" },
    ]);
  });

  it("clamps end-of-file deletions to the last existing buffer line", () => {
    // Removing trailing lines: marker on the last surviving buffer line.
    const changes = computeLineChanges("a\nb\nc\n", "a\n");
    expect(changes).toEqual([{ line: 1, kind: "delete-above" }]);
  });

  it("places start-of-file deletions at line 1", () => {
    const changes = computeLineChanges("a\nb\nc\n", "b\nc\n");
    expect(changes).toEqual([{ line: 1, kind: "delete-above" }]);
  });

  it("treats every line as add when head is empty", () => {
    const changes = computeLineChanges("", "a\nb\n");
    expect(changes).toEqual([
      { line: 1, kind: "add" },
      { line: 2, kind: "add" },
    ]);
  });

  it("emits a single delete-above at line 1 when the buffer is empty", () => {
    const changes = computeLineChanges("a\nb\n", "");
    expect(changes).toEqual([{ line: 1, kind: "delete-above" }]);
  });
});
