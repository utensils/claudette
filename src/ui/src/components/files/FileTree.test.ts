import { describe, expect, it } from "vitest";
import { resolveFileTreeActivation } from "./fileTreeStatus";
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
});
