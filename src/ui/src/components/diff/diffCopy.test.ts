import { describe, expect, it } from "vitest";
import { oldSideTextFromDiff } from "./diffCopy";
import type { FileDiff } from "../../types";

describe("oldSideTextFromDiff", () => {
  it("reconstructs deleted file content from removed diff lines", () => {
    const diff: FileDiff = {
      path: "src/index.rs",
      is_binary: false,
      hunks: [
        {
          old_start: 1,
          new_start: 0,
          header: "@@ -1,2 +0,0 @@",
          lines: [
            {
              line_type: "Removed",
              content: "use std::path::Path;",
              old_line_number: 1,
              new_line_number: null,
            },
            {
              line_type: "Removed",
              content: "fn main() {}",
              old_line_number: 2,
              new_line_number: null,
            },
          ],
        },
      ],
    };

    expect(oldSideTextFromDiff(diff)).toBe("use std::path::Path;\nfn main() {}\n");
  });

  it("includes context lines when reconstructing the old side", () => {
    const diff: FileDiff = {
      path: "src/index.rs",
      is_binary: false,
      hunks: [
        {
          old_start: 1,
          new_start: 1,
          header: "@@ -1,2 +1,2 @@",
          lines: [
            {
              line_type: "Context",
              content: "unchanged",
              old_line_number: 1,
              new_line_number: 1,
            },
            {
              line_type: "Removed",
              content: "old",
              old_line_number: 2,
              new_line_number: null,
            },
            {
              line_type: "Added",
              content: "new",
              old_line_number: null,
              new_line_number: 2,
            },
          ],
        },
      ],
    };

    expect(oldSideTextFromDiff(diff)).toBe("unchanged\nold\n");
  });

  it("does not produce text for binary or empty diffs", () => {
    expect(oldSideTextFromDiff({ path: "logo.png", is_binary: true, hunks: [] }))
      .toBeNull();
    expect(oldSideTextFromDiff({ path: "empty.ts", is_binary: false, hunks: [] }))
      .toBeNull();
  });
});
