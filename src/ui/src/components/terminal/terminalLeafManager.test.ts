import { describe, it, expect } from "vitest";
import type { TerminalPaneNode } from "../../types/terminal";
import { splitLeaf, closeLeaf } from "../../stores/terminalPaneTree";
import {
  collectNeededLeaves,
  diffLeaves,
  type LeafInstanceSnapshot,
  type NeededLeaf,
} from "./terminalLeafManager";

function leaf(id: string): TerminalPaneNode {
  return { kind: "leaf", id };
}

function tab(id: number) {
  return { id, workspaceId: "ws", worktreePath: "/tmp/ws" };
}

function needed(leafId: string, tabId = 1): NeededLeaf {
  return { leafId, tabId, workspaceId: "ws", worktreePath: "/tmp/ws" };
}

function existing(leafId: string, tabId = 1): LeafInstanceSnapshot {
  return { leafId, tabId, workspaceId: "ws" };
}

describe("collectNeededLeaves", () => {
  it("flattens leaves across all tabs, stamped with workspace context", () => {
    const trees: Record<number, TerminalPaneNode> = {
      1: leaf("a"),
      2: {
        kind: "split",
        id: "s",
        direction: "horizontal",
        children: [leaf("b"), leaf("c")],
        sizes: [50, 50],
      },
    };
    const result = collectNeededLeaves([tab(1), tab(2)], trees);
    expect(result.map((r) => r.leafId)).toEqual(["a", "b", "c"]);
    expect(result.every((r) => r.workspaceId === "ws")).toBe(true);
  });

  it("skips tabs with no tree (trees will be created lazily on next tick)", () => {
    const result = collectNeededLeaves([tab(1), tab(2)], { 1: leaf("a") });
    expect(result.map((r) => r.leafId)).toEqual(["a"]);
  });
});

describe("diffLeaves", () => {
  it("returns empty diffs when needed and existing match", () => {
    const result = diffLeaves(
      [needed("a"), needed("b")],
      new Map([
        ["a", existing("a")],
        ["b", existing("b")],
      ]),
    );
    expect(result.toCreate).toEqual([]);
    expect(result.toDestroy).toEqual([]);
  });

  it("schedules creation for leaves not yet instantiated", () => {
    const result = diffLeaves([needed("a"), needed("b")], new Map());
    expect(result.toCreate.map((c) => c.leafId)).toEqual(["a", "b"]);
    expect(result.toDestroy).toEqual([]);
  });

  it("schedules destruction for instances whose leafId is no longer in the tree", () => {
    const result = diffLeaves(
      [needed("a")],
      new Map([
        ["a", existing("a")],
        ["gone", existing("gone")],
      ]),
    );
    expect(result.toCreate).toEqual([]);
    expect(result.toDestroy).toEqual(["gone"]);
  });

  // The regression test for the bug the user hit: splitting a single-leaf
  // tree must NOT schedule the original leaf for destruction, and must
  // schedule only the freshly-created sibling for creation.
  it("REGRESSION: splitting a tab creates only the new leaf and destroys none", () => {
    const tree0 = leaf("A");
    const { tree: tree1, newLeafId } = splitLeaf(tree0, "A", "horizontal");
    expect(newLeafId).not.toBeNull();

    const instancesBeforeSplit = new Map<string, LeafInstanceSnapshot>([
      ["A", existing("A")],
    ]);
    const needed = collectNeededLeaves([tab(1)], { 1: tree1 });
    const diff = diffLeaves(needed, instancesBeforeSplit);

    expect(diff.toDestroy).toEqual([]);
    expect(diff.toCreate.map((c) => c.leafId)).toEqual([newLeafId]);
  });

  it("REGRESSION: closing one half of a split preserves the surviving leaf", () => {
    const tree0 = leaf("A");
    const { tree: tree1, newLeafId } = splitLeaf(tree0, "A", "horizontal");
    const newId = newLeafId!;
    const instancesBeforeClose = new Map<string, LeafInstanceSnapshot>([
      ["A", existing("A")],
      [newId, existing(newId)],
    ]);

    const { tree: tree2 } = closeLeaf(tree1, newId);
    const needed = collectNeededLeaves([tab(1)], { 1: tree2 });
    const diff = diffLeaves(needed, instancesBeforeClose);

    expect(diff.toCreate).toEqual([]);
    expect(diff.toDestroy).toEqual([newId]);
  });

  it("REGRESSION: splitting a pane twice in a row only creates the two new leaves", () => {
    const tree0 = leaf("A");
    const { tree: tree1, newLeafId: b } = splitLeaf(tree0, "A", "horizontal");
    const { tree: tree2, newLeafId: c } = splitLeaf(tree1, b!, "vertical");

    const instances = new Map<string, LeafInstanceSnapshot>([
      ["A", existing("A")],
      [b!, existing(b!)],
    ]);
    const needed = collectNeededLeaves([tab(1)], { 1: tree2 });
    const diff = diffLeaves(needed, instances);

    expect(diff.toDestroy).toEqual([]);
    expect(diff.toCreate.map((c) => c.leafId)).toEqual([c]);
  });
});
