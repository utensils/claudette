import { describe, expect, it } from "vitest";
import { resolveFileTreeActivation, statusForOpenFileTab } from "./fileTreeStatus";
import type { FileTreeNode } from "../../utils/buildFileTree";

describe("resolveFileTreeActivation", () => {
  it("opens deleted files as diffs", () => {
    const node: FileTreeNode & { kind: "file" } = {
      kind: "file",
      path: "src/removed.ts",
      name: "removed.ts",
      git_status: "Deleted",
      git_layer: "staged",
    };

    expect(resolveFileTreeActivation(node)).toEqual({
      kind: "diff",
      path: "src/removed.ts",
      layer: "staged",
    });
  });

  it("maps mixed deleted files to the unstaged diff layer", () => {
    const node: FileTreeNode & { kind: "file" } = {
      kind: "file",
      path: "src/removed.ts",
      name: "removed.ts",
      git_status: "Deleted",
      git_layer: "mixed",
    };

    expect(resolveFileTreeActivation(node)).toEqual({
      kind: "diff",
      path: "src/removed.ts",
      layer: "unstaged",
    });
  });

  it("opens existing files in the editor", () => {
    const node: FileTreeNode & { kind: "file" } = {
      kind: "file",
      path: "src/app.ts",
      name: "app.ts",
      git_status: "Modified",
      git_layer: "unstaged",
    };

    expect(resolveFileTreeActivation(node)).toEqual({
      kind: "file",
      path: "src/app.ts",
    });
  });

  it("opens non-deleted files in the editor when layer metadata is missing", () => {
    const node: FileTreeNode & { kind: "file" } = {
      kind: "file",
      path: "src/app.ts",
      name: "app.ts",
      git_status: "Modified",
      git_layer: null,
    };

    expect(resolveFileTreeActivation(node)).toEqual({
      kind: "file",
      path: "src/app.ts",
    });
  });
});

describe("statusForOpenFileTab", () => {
  it("returns status for open file tabs from current git status groups", () => {
    expect(
      statusForOpenFileTab("src/app.ts", {
        committed: [],
        staged: [],
        unstaged: [{ path: "src/app.ts", status: "Modified" }],
        untracked: [],
      }),
    ).toBe("Modified");
  });

  it("ignores committed-only changes for open file tabs", () => {
    expect(
      statusForOpenFileTab("src/app.ts", {
        committed: [{ path: "src/app.ts", status: "Modified" }],
        staged: [],
        unstaged: [],
        untracked: [],
      }),
    ).toBeNull();
  });

  it("uses deleted status when a file appears in multiple current groups", () => {
    expect(
      statusForOpenFileTab("src/app.ts", {
        committed: [],
        staged: [{ path: "src/app.ts", status: "Added" }],
        unstaged: [{ path: "src/app.ts", status: "Deleted" }],
        untracked: [],
      }),
    ).toBe("Deleted");
  });
});
