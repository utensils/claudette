/**
 * Pure helpers for the terminal split-pane binary tree.
 *
 * The tree is the ephemeral layout inside a single terminal tab. Each leaf
 * maps 1:1 to an xterm.js instance and a PTY; each split holds exactly two
 * children and a direction. The helpers here never mutate — they return a new
 * tree so Zustand's structural-sharing comparisons work correctly.
 *
 * Kept free of React / xterm imports so they can be unit-tested in isolation.
 */

import type {
  TerminalLeafPane,
  TerminalPaneNode,
  TerminalPaneNodeId,
  TerminalSplitDirection,
  TerminalSplitPane,
} from "../types/terminal";

// crypto.randomUUID is available in Vite/Tauri runtime and jsdom (vitest)
// environments. Narrow type so tests that don't polyfill still compile.
function uuid(): string {
  return crypto.randomUUID();
}

export function makeLeaf(): TerminalLeafPane {
  return { kind: "leaf", id: uuid() };
}

export function findLeaf(
  tree: TerminalPaneNode,
  id: TerminalPaneNodeId,
): TerminalLeafPane | null {
  if (tree.kind === "leaf") return tree.id === id ? tree : null;
  return findLeaf(tree.children[0], id) ?? findLeaf(tree.children[1], id);
}

// Returns the split whose direct children include the node with `id`.
// Returns null if the id is the root, or is not present. Used by closeLeaf
// and updateSizes to locate the split to rewrite.
export function findParentSplit(
  tree: TerminalPaneNode,
  id: TerminalPaneNodeId,
): TerminalSplitPane | null {
  if (tree.kind === "leaf") return null;
  if (tree.children[0].id === id || tree.children[1].id === id) return tree;
  return (
    findParentSplit(tree.children[0], id) ??
    findParentSplit(tree.children[1], id)
  );
}

export function countLeaves(tree: TerminalPaneNode): number {
  if (tree.kind === "leaf") return 1;
  return countLeaves(tree.children[0]) + countLeaves(tree.children[1]);
}

export function allLeafIds(tree: TerminalPaneNode): TerminalPaneNodeId[] {
  if (tree.kind === "leaf") return [tree.id];
  return [...allLeafIds(tree.children[0]), ...allLeafIds(tree.children[1])];
}

export function findLeafByPtyId(
  tree: TerminalPaneNode,
  ptyId: number,
): TerminalLeafPane | null {
  if (tree.kind === "leaf") return tree.ptyId === ptyId ? tree : null;
  return (
    findLeafByPtyId(tree.children[0], ptyId) ??
    findLeafByPtyId(tree.children[1], ptyId)
  );
}

export interface SplitLeafResult {
  tree: TerminalPaneNode;
  // The id of the new leaf created by the split. null when the operation
  // was a no-op (id not a leaf / not present).
  newLeafId: TerminalPaneNodeId | null;
}

// Replace the leaf with the given id by a 50/50 split whose FIRST child
// is the existing leaf (keeping the original PTY in place visually on
// the left/top) and whose SECOND child is a fresh leaf. No-ops if the
// id doesn't match a leaf. The content-preservation problem the shell's
// SIGWINCH-driven clear used to cause is handled at xterm level in
// TerminalPanel (padding the viewport into scrollback before the
// redraw, then scrolling the display up afterwards), so there is no
// longer a reason to skew the initial sizing.
const INITIAL_SPLIT_SIZES: [number, number] = [50, 50];

export function splitLeaf(
  tree: TerminalPaneNode,
  targetId: TerminalPaneNodeId,
  direction: TerminalSplitDirection,
): SplitLeafResult {
  if (tree.kind === "leaf") {
    if (tree.id !== targetId) return { tree, newLeafId: null };
    const fresh = makeLeaf();
    return {
      tree: {
        kind: "split",
        id: uuid(),
        direction,
        children: [tree, fresh],
        sizes: INITIAL_SPLIT_SIZES,
      },
      newLeafId: fresh.id,
    };
  }
  const left = splitLeaf(tree.children[0], targetId, direction);
  if (left.newLeafId) {
    return {
      tree: { ...tree, children: [left.tree, tree.children[1]] },
      newLeafId: left.newLeafId,
    };
  }
  const right = splitLeaf(tree.children[1], targetId, direction);
  if (right.newLeafId) {
    return {
      tree: { ...tree, children: [tree.children[0], right.tree] },
      newLeafId: right.newLeafId,
    };
  }
  return { tree, newLeafId: null };
}

export interface CloseLeafResult {
  tree: TerminalPaneNode;
  // True when a leaf was actually removed. False when the tree is a single
  // leaf (caller should treat this as "close the whole tab"), or when the
  // id was not found.
  closed: boolean;
  // The id of a leaf that should receive focus after the close — the
  // leftmost leaf of the promoted sibling subtree. Null when closed=false.
  promotedLeafId: TerminalPaneNodeId | null;
}

// Remove the leaf with the given id and collapse its parent split by
// promoting the sibling subtree in place. If the tree is a single leaf, we
// refuse (the caller should close the enclosing tab instead).
export function closeLeaf(
  tree: TerminalPaneNode,
  targetId: TerminalPaneNodeId,
): CloseLeafResult {
  if (tree.kind === "leaf") {
    return { tree, closed: false, promotedLeafId: null };
  }

  // Direct child match: promote the sibling subtree. Restrict to leaf
  // children — a split node happens to have its own id, and matching it
  // here would silently delete a whole subtree on a stale/incorrect id.
  if (tree.children[0].kind === "leaf" && tree.children[0].id === targetId) {
    const sibling = tree.children[1];
    return {
      tree: sibling,
      closed: true,
      promotedLeafId: leftmostLeafId(sibling),
    };
  }
  if (tree.children[1].kind === "leaf" && tree.children[1].id === targetId) {
    const sibling = tree.children[0];
    return {
      tree: sibling,
      closed: true,
      promotedLeafId: leftmostLeafId(sibling),
    };
  }

  // Recurse.
  const left = closeLeaf(tree.children[0], targetId);
  if (left.closed) {
    return {
      tree: { ...tree, children: [left.tree, tree.children[1]] },
      closed: true,
      promotedLeafId: left.promotedLeafId,
    };
  }
  const right = closeLeaf(tree.children[1], targetId);
  if (right.closed) {
    return {
      tree: { ...tree, children: [tree.children[0], right.tree] },
      closed: true,
      promotedLeafId: right.promotedLeafId,
    };
  }
  return { tree, closed: false, promotedLeafId: null };
}

function leftmostLeafId(tree: TerminalPaneNode): TerminalPaneNodeId {
  return tree.kind === "leaf" ? tree.id : leftmostLeafId(tree.children[0]);
}

function rightmostLeafId(tree: TerminalPaneNode): TerminalPaneNodeId {
  return tree.kind === "leaf" ? tree.id : rightmostLeafId(tree.children[1]);
}

// Rewrite sizes on a specific split node.
export function updateSizes(
  tree: TerminalPaneNode,
  splitId: TerminalPaneNodeId,
  sizes: [number, number],
): TerminalPaneNode {
  if (tree.kind === "leaf") return tree;
  if (tree.id === splitId) {
    // Preserve referential equality when the sizes haven't actually
    // changed so `setPaneSizes` short-circuits and Zustand doesn't kick
    // off a wasted rerender. react-resizable-panels' onLayoutChanged can
    // fire repeatedly with identical sizes during a drag.
    if (tree.sizes[0] === sizes[0] && tree.sizes[1] === sizes[1]) return tree;
    return { ...tree, sizes };
  }
  const nextLeft = updateSizes(tree.children[0], splitId, sizes);
  const nextRight = updateSizes(tree.children[1], splitId, sizes);
  if (nextLeft === tree.children[0] && nextRight === tree.children[1]) {
    return tree;
  }
  return { ...tree, children: [nextLeft, nextRight] };
}

/**
 * Returns true when the given leaf should currently receive keyboard focus.
 *
 * A leaf is focus-eligible only when:
 *   - the terminal panel is visible at all;
 *   - the leaf belongs to the tab the user currently has active in the
 *     workspace (we don't steal focus into a leaf of a background tab);
 *   - the leaf is marked as the active pane for that tab.
 *
 * Pure so we can unit-test the "splitting jumps focus to the new pane"
 * and "closing jumps focus back to the sibling" contracts without needing
 * a DOM. See `shouldFocusLeaf` tests in terminalPaneTree.test.ts.
 */
export function shouldFocusLeaf(
  leafId: TerminalPaneNodeId,
  tabId: number,
  activeLeafByTab: Readonly<Record<number, TerminalPaneNodeId>>,
  selectedTabId: number | null,
  panelVisible: boolean,
): boolean {
  if (!panelVisible) return false;
  if (selectedTabId == null || tabId !== selectedTabId) return false;
  return activeLeafByTab[tabId] === leafId;
}

export type PaneNavigationDirection = "left" | "right" | "up" | "down";

// Return the id of the leaf to focus when moving from `fromId` in the given
// direction. The algorithm walks up the tree looking for the first split
// whose direction and child ordering lets us "escape" in the requested axis,
// then descends the sibling subtree along the opposite edge.
//
// Example (horizontal root, vertical right subtree):
//   +---+---+
//   | a | b |
//   |   +---+
//   |   | c |
//   +---+---+
// neighborLeaf(tree, 'a', 'right') -> leftmost leaf of right subtree = 'b'.
// neighborLeaf(tree, 'c', 'up')    -> 'b' (escape the vertical split upward).
export function neighborLeaf(
  tree: TerminalPaneNode,
  fromId: TerminalPaneNodeId,
  direction: PaneNavigationDirection,
): TerminalPaneNodeId | null {
  if (!findLeaf(tree, fromId)) return null;

  const axis: TerminalSplitDirection =
    direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const forward = direction === "right" || direction === "down";

  // Walk up using repeated findParentSplit calls (O(depth^2), fine for small trees).
  let currentId: TerminalPaneNodeId = fromId;
  while (true) {
    const parent = findParentSplit(tree, currentId);
    if (!parent) return null;
    const fromIsLeft = parent.children[0].id === currentId;
    if (parent.direction === axis) {
      if (forward && fromIsLeft) {
        return edgeLeafId(parent.children[1], direction);
      }
      if (!forward && !fromIsLeft) {
        return edgeLeafId(parent.children[0], direction);
      }
    }
    currentId = parent.id;
  }
}

// Pick the leaf on the "incoming" edge of a subtree when entering from the
// given direction: coming from the left, we land on the leftmost leaf; from
// above, we land on the topmost leaf — and so on.
function edgeLeafId(
  subtree: TerminalPaneNode,
  direction: PaneNavigationDirection,
): TerminalPaneNodeId {
  // When entering rightward or downward, we land on the leading edge
  // (leftmost / topmost), which is the first child path.
  // When entering leftward or upward, we land on the trailing edge.
  return direction === "right" || direction === "down"
    ? leftmostLeafId(subtree)
    : rightmostLeafId(subtree);
}
