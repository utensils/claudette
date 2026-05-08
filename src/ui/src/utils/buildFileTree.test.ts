import { describe, expect, it } from "vitest";
import { buildFileTree } from "./buildFileTree";
import type { FileEntry } from "../services/tauri";

describe("buildFileTree", () => {
  it("propagates file status and descendant counts", () => {
    const entries: FileEntry[] = [
      {
        path: "src/app.ts",
        is_directory: false,
        git_status: "Modified",
        git_layer: "unstaged",
      },
      {
        path: "src/nested/new.ts",
        is_directory: false,
        git_status: "Added",
        git_layer: "untracked",
      },
      {
        path: "README.md",
        is_directory: false,
        git_status: null,
        git_layer: null,
      },
    ];

    const tree = buildFileTree(entries);
    const src = tree.find((node) => node.kind === "dir" && node.path === "src/");

    expect(src).toMatchObject({
      kind: "dir",
      path: "src/",
      statusCount: 2,
    });
    expect(src?.kind === "dir" ? src.children[1] : null).toMatchObject({
      kind: "file",
      path: "src/app.ts",
      git_status: "Modified",
      git_layer: "unstaged",
    });
  });

  it("picks Modified over Added when aggregating folder status", () => {
    const entries: FileEntry[] = [
      {
        path: "src/added.ts",
        is_directory: false,
        git_status: "Added",
        git_layer: "untracked",
      },
      {
        path: "src/changed.ts",
        is_directory: false,
        git_status: "Modified",
        git_layer: "unstaged",
      },
    ];

    const tree = buildFileTree(entries);
    const src = tree[0];
    expect(src).toMatchObject({
      kind: "dir",
      folderStatus: "Modified",
      statusCount: 2,
    });
  });

  it("propagates folder status up through nested directories", () => {
    const entries: FileEntry[] = [
      {
        path: "src/deep/nested/added.ts",
        is_directory: false,
        git_status: "Added",
        git_layer: "untracked",
      },
    ];

    const tree = buildFileTree(entries);
    const src = tree[0];
    expect(src.kind === "dir" ? src.folderStatus : null).toBe("Added");
    const deep =
      src.kind === "dir" && src.children[0].kind === "dir"
        ? src.children[0]
        : null;
    expect(deep?.folderStatus).toBe("Added");
  });

  it("keeps deleted virtual entries in the tree", () => {
    const entries: FileEntry[] = [
      {
        path: "src/removed.ts",
        is_directory: false,
        git_status: "Deleted",
        git_layer: "staged",
      },
    ];

    const tree = buildFileTree(entries);
    const src = tree[0];
    const removed = src.kind === "dir" ? src.children[0] : null;

    expect(src.path).toBe("src/");
    expect(src).toMatchObject({
      kind: "dir",
      path: "src/",
      statusCount: 1,
    });
    expect(removed).toMatchObject({
      kind: "file",
      path: "src/removed.ts",
      git_status: "Deleted",
      git_layer: "staged",
    });
  });
});
