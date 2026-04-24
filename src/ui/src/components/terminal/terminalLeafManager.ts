/**
 * Imperative per-leaf xterm/PTY lifecycle management.
 *
 * The pane tree is React-rendered, but the xterm instances inside each leaf
 * are NOT. A leaf's xterm container is a detached `<div>` owned by a ref-held
 * `Map<leafId, LeafInstance>`. When the pane tree re-renders (because a
 * split/close rewrote the structure), we imperatively `appendChild` each
 * container into the `data-pane-target="{leafId}"` div that the tree emitted
 * for that leaf. Xterm is happy to be re-parented — its own DOM moves along
 * as children of the container — so its scrollback, cursor state, and the
 * underlying PTY all stay intact across splits.
 *
 * This module contains the pure diff helper that drives reconciliation.
 * Keeping it independent of React and xterm lets us unit-test the
 * "splits must not destroy existing panes" contract directly.
 */

import type { TerminalPaneNode, TerminalPaneNodeId } from "../../types/terminal";
import { allLeafIds } from "../../stores/terminalPaneTree";

export interface NeededLeaf {
  leafId: TerminalPaneNodeId;
  tabId: number;
  workspaceId: string;
  worktreePath: string;
}

export interface LeafInstanceSnapshot {
  leafId: TerminalPaneNodeId;
  // The fields below are carried so callers don't need to cross-reference
  // the underlying store to know what workspace/tab an instance was created
  // for.
  tabId: number;
  workspaceId: string;
}

export interface LeafDiff {
  // Leaves that need a fresh instance (xterm + PTY spawn).
  toCreate: NeededLeaf[];
  // leafIds whose instances should be torn down (xterm disposed, PTY closed).
  toDestroy: TerminalPaneNodeId[];
}

/**
 * Collect every leaf currently rendered across all tabs, stamped with the
 * workspace/worktree it belongs to. Tabs without a workspace context
 * (e.g. their workspace was removed mid-render) are skipped; their
 * instances will be garbage-collected via `diffLeaves` returning them
 * in `toDestroy`.
 */
export function collectNeededLeaves(
  tabs: ReadonlyArray<{ id: number; workspaceId: string; worktreePath: string }>,
  trees: Readonly<Record<number, TerminalPaneNode>>,
): NeededLeaf[] {
  const out: NeededLeaf[] = [];
  for (const tab of tabs) {
    const tree = trees[tab.id];
    if (!tree) continue;
    for (const leafId of allLeafIds(tree)) {
      out.push({
        leafId,
        tabId: tab.id,
        workspaceId: tab.workspaceId,
        worktreePath: tab.worktreePath,
      });
    }
  }
  return out;
}

/**
 * Compute the create/destroy list needed to move from `existing` to `needed`.
 *
 * CRITICAL PROPERTY: a leafId present in both sets produces NO entry in
 * either `toCreate` or `toDestroy`. This is the guarantee that makes
 * splitting a pane preserve the original pane's xterm and PTY — the
 * original leaf is still in the tree after the split (as one child of the
 * new split node), so `diffLeaves` does not mark it for destruction.
 *
 * A regression test in `terminalLeafManager.test.ts` locks this property
 * in place.
 */
export function diffLeaves(
  needed: ReadonlyArray<NeededLeaf>,
  existing: ReadonlyMap<TerminalPaneNodeId, LeafInstanceSnapshot>,
): LeafDiff {
  const neededIds = new Set(needed.map((n) => n.leafId));
  const toCreate = needed.filter((n) => !existing.has(n.leafId));
  const toDestroy: TerminalPaneNodeId[] = [];
  for (const id of existing.keys()) {
    if (!neededIds.has(id)) toDestroy.push(id);
  }
  return { toCreate, toDestroy };
}
