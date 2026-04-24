import { describe, it, expect } from "vitest";
import type {
  TerminalLeafPane,
  TerminalPaneNode,
  TerminalSplitPane,
} from "../types/terminal";
import {
  allLeafIds,
  closeLeaf,
  countLeaves,
  findLeaf,
  findParentSplit,
  makeLeaf,
  neighborLeaf,
  splitLeaf,
  updateSizes,
} from "./terminalPaneTree";

function leaf(id: string): TerminalLeafPane {
  return { kind: "leaf", id };
}

function split(
  id: string,
  direction: "horizontal" | "vertical",
  left: TerminalPaneNode,
  right: TerminalPaneNode,
  sizes: [number, number] = [50, 50],
): TerminalSplitPane {
  return { kind: "split", id, direction, children: [left, right], sizes };
}

describe("makeLeaf", () => {
  it("produces a leaf with a fresh id each call", () => {
    const a = makeLeaf();
    const b = makeLeaf();
    expect(a.kind).toBe("leaf");
    expect(b.kind).toBe("leaf");
    expect(a.id).not.toBe(b.id);
    // crypto.randomUUID produces non-empty strings
    expect(a.id.length).toBeGreaterThan(0);
  });
});

describe("findLeaf", () => {
  it("returns a lone leaf when ids match", () => {
    const tree = leaf("a");
    expect(findLeaf(tree, "a")).toEqual(tree);
  });

  it("returns null when id is absent", () => {
    const tree = leaf("a");
    expect(findLeaf(tree, "missing")).toBeNull();
  });

  it("descends into both children of a split", () => {
    const tree = split("s", "horizontal", leaf("left"), leaf("right"));
    expect(findLeaf(tree, "left")?.id).toBe("left");
    expect(findLeaf(tree, "right")?.id).toBe("right");
  });

  it("finds a leaf nested several levels deep", () => {
    const tree = split(
      "s1",
      "horizontal",
      leaf("a"),
      split("s2", "vertical", leaf("b"), split("s3", "horizontal", leaf("c"), leaf("d"))),
    );
    expect(findLeaf(tree, "d")?.id).toBe("d");
  });
});

describe("findParentSplit", () => {
  it("returns null for the root when it is a leaf", () => {
    expect(findParentSplit(leaf("a"), "a")).toBeNull();
  });

  it("returns null for the root split itself", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    expect(findParentSplit(tree, "s")).toBeNull();
  });

  it("returns the parent split for a direct child leaf", () => {
    const s = split("s", "horizontal", leaf("a"), leaf("b"));
    expect(findParentSplit(s, "a")?.id).toBe("s");
    expect(findParentSplit(s, "b")?.id).toBe("s");
  });

  it("finds the nearest parent in a deeper tree", () => {
    const inner = split("inner", "vertical", leaf("c"), leaf("d"));
    const root = split("root", "horizontal", leaf("a"), inner);
    expect(findParentSplit(root, "c")?.id).toBe("inner");
    expect(findParentSplit(root, "a")?.id).toBe("root");
    expect(findParentSplit(root, "inner")?.id).toBe("root");
  });
});

describe("countLeaves", () => {
  it("returns 1 for a lone leaf", () => {
    expect(countLeaves(leaf("a"))).toBe(1);
  });

  it("sums leaves across splits", () => {
    const tree = split(
      "s1",
      "horizontal",
      split("s2", "vertical", leaf("a"), leaf("b")),
      leaf("c"),
    );
    expect(countLeaves(tree)).toBe(3);
  });
});

describe("allLeafIds", () => {
  it("traverses left-to-right (DFS in-order)", () => {
    const tree = split(
      "s1",
      "horizontal",
      split("s2", "vertical", leaf("a"), leaf("b")),
      split("s3", "vertical", leaf("c"), leaf("d")),
    );
    expect(allLeafIds(tree)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("splitLeaf", () => {
  it("turns a lone leaf into a 50/50 split with the new leaf second", () => {
    const tree = leaf("a");
    const { tree: next, newLeafId } = splitLeaf(tree, "a", "horizontal");
    expect(next.kind).toBe("split");
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.direction).toBe("horizontal");
    expect(next.sizes).toEqual([50, 50]);
    expect(next.children[0]).toEqual(leaf("a"));
    expect(next.children[1].id).toBe(newLeafId);
    expect(next.children[1].kind).toBe("leaf");
  });

  it("only replaces the matching leaf in a nested tree", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const { tree: next, newLeafId } = splitLeaf(tree, "b", "vertical");
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.children[0]).toEqual(leaf("a"));
    const newChild = next.children[1];
    if (newChild.kind !== "split") throw new Error("expected nested split");
    expect(newChild.direction).toBe("vertical");
    expect(newChild.children[0]).toEqual(leaf("b"));
    expect(newChild.children[1].id).toBe(newLeafId);
  });

  it("is a no-op (returns same tree) when the leaf id is not found", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const { tree: next, newLeafId } = splitLeaf(tree, "missing", "horizontal");
    expect(next).toBe(tree);
    expect(newLeafId).toBeNull();
  });

  it("is a no-op when targeting a split id (not a leaf)", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const { tree: next, newLeafId } = splitLeaf(tree, "s", "horizontal");
    expect(next).toBe(tree);
    expect(newLeafId).toBeNull();
  });
});

describe("closeLeaf", () => {
  it("refuses to close the sole leaf — caller handles tab close instead", () => {
    const tree = leaf("a");
    const { tree: next, closed, promotedLeafId } = closeLeaf(tree, "a");
    expect(next).toBe(tree);
    expect(closed).toBe(false);
    expect(promotedLeafId).toBeNull();
  });

  it("promotes the sibling when one of two direct children is closed", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const { tree: next, closed, promotedLeafId } = closeLeaf(tree, "a");
    expect(closed).toBe(true);
    expect(promotedLeafId).toBe("b");
    expect(next).toEqual(leaf("b"));
  });

  it("promotes a sibling subtree intact when closing its sibling leaf", () => {
    const siblingSubtree = split("inner", "vertical", leaf("x"), leaf("y"));
    const tree = split("root", "horizontal", leaf("a"), siblingSubtree);
    const { tree: next, closed } = closeLeaf(tree, "a");
    expect(closed).toBe(true);
    expect(next).toEqual(siblingSubtree);
  });

  it("collapses the correct split deep in the tree", () => {
    const inner = split("inner", "vertical", leaf("c"), leaf("d"));
    const tree = split("root", "horizontal", leaf("a"), inner);
    const { tree: next, closed, promotedLeafId } = closeLeaf(tree, "c");
    expect(closed).toBe(true);
    expect(promotedLeafId).toBe("d");
    expect(next).toEqual(split("root", "horizontal", leaf("a"), leaf("d")));
  });

  it("returns closed=false when id is not a leaf in the tree", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const { tree: next, closed } = closeLeaf(tree, "missing");
    expect(next).toBe(tree);
    expect(closed).toBe(false);
  });
});

describe("updateSizes", () => {
  it("updates the sizes of the targeted split", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"), [50, 50]);
    const next = updateSizes(tree, "s", [30, 70]);
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.sizes).toEqual([30, 70]);
  });

  it("leaves other splits untouched", () => {
    const inner = split("inner", "vertical", leaf("c"), leaf("d"), [50, 50]);
    const tree = split("root", "horizontal", leaf("a"), inner, [50, 50]);
    const next = updateSizes(tree, "inner", [25, 75]);
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.sizes).toEqual([50, 50]);
    const innerNext = next.children[1];
    if (innerNext.kind !== "split") throw new Error("expected nested split");
    expect(innerNext.sizes).toEqual([25, 75]);
  });

  it("is a no-op when id is not found", () => {
    const tree = split("s", "horizontal", leaf("a"), leaf("b"));
    const next = updateSizes(tree, "missing", [10, 90]);
    expect(next).toBe(tree);
  });
});

describe("neighborLeaf", () => {
  //  Layout (horizontal root = columns a | right-subtree):
  //  +---+---+
  //  | a | b |
  //  |   +---+
  //  |   | c |
  //  +---+---+
  const tree = split(
    "root",
    "horizontal",
    leaf("a"),
    split("right", "vertical", leaf("b"), leaf("c")),
  );

  it("moves right from 'a' across a horizontal split to the top of the right column", () => {
    expect(neighborLeaf(tree, "a", "right")).toBe("b");
  });

  it("moves left from 'b' back to 'a'", () => {
    expect(neighborLeaf(tree, "b", "left")).toBe("a");
  });

  it("moves down from 'b' to 'c' across a vertical split", () => {
    expect(neighborLeaf(tree, "b", "down")).toBe("c");
  });

  it("moves up from 'c' to 'b'", () => {
    expect(neighborLeaf(tree, "c", "up")).toBe("b");
  });

  it("returns null when there is no neighbor in that direction", () => {
    expect(neighborLeaf(tree, "a", "left")).toBeNull();
    expect(neighborLeaf(tree, "a", "up")).toBeNull();
    expect(neighborLeaf(tree, "a", "down")).toBeNull();
    expect(neighborLeaf(tree, "b", "up")).toBeNull();
    expect(neighborLeaf(tree, "c", "down")).toBeNull();
    expect(neighborLeaf(tree, "c", "right")).toBeNull();
  });

  it("returns null for a lone leaf", () => {
    expect(neighborLeaf(leaf("only"), "only", "left")).toBeNull();
  });

  it("returns null when id is missing", () => {
    expect(neighborLeaf(tree, "missing", "right")).toBeNull();
  });
});
