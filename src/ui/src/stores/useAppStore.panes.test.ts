import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { TerminalTab } from "../types/terminal";

const WS = "workspace-panes";

function makeTab(id: number, workspaceId = WS): TerminalTab {
  return {
    id,
    workspace_id: workspaceId,
    title: `Terminal ${id}`,
    is_script_output: false,
    sort_order: id,
    created_at: "",
  };
}

function resetStore() {
  useAppStore.setState({
    terminalTabs: {},
    activeTerminalTabId: {},
    terminalPaneTrees: {},
    activeTerminalPaneId: {},
    terminalPaneMaxLeaves: 6,
    terminalPanelVisible: false,
    workspaces: [],
    repositories: [],
    selectedWorkspaceId: null,
    workspaceTerminalCommands: {},
    unreadCompletions: new Set(),
  });
}

describe("pane slice: ensurePaneTree", () => {
  beforeEach(resetStore);

  it("creates a single-leaf tree and sets the leaf active on first call", () => {
    const leafId = useAppStore.getState().ensurePaneTree(1);
    const tree = useAppStore.getState().terminalPaneTrees[1];
    expect(tree).toEqual({ kind: "leaf", id: leafId });
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBe(leafId);
  });

  it("is idempotent — a second call returns the same leaf id", () => {
    const first = useAppStore.getState().ensurePaneTree(1);
    const second = useAppStore.getState().ensurePaneTree(1);
    expect(second).toBe(first);
  });

  it("backfills the active leaf id for an existing leaf tree", () => {
    const leafId = useAppStore.getState().ensurePaneTree(1);
    useAppStore.setState({ activeTerminalPaneId: {} });

    const picked = useAppStore.getState().ensurePaneTree(1);

    expect(picked).toBe(leafId);
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBe(leafId);
  });

  // Regression: a split tree with no active-pane entry must NOT be
  // replaced by a fresh single leaf. ensurePaneTree should keep the
  // split and fall back to the leftmost leaf.
  it("preserves an existing split tree when active-pane id is missing", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    const newLeaf = useAppStore.getState().splitPane(1, rootLeaf, "horizontal");
    expect(newLeaf).not.toBeNull();
    const splitTree = useAppStore.getState().terminalPaneTrees[1];
    // Simulate the stored active-pane id being lost (e.g. store hydration
    // skipped it, or the id was stale and got cleared).
    useAppStore.setState({ activeTerminalPaneId: {} });

    const picked = useAppStore.getState().ensurePaneTree(1);

    expect(useAppStore.getState().terminalPaneTrees[1]).toBe(splitTree);
    expect(picked).toBe(rootLeaf);
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBe(rootLeaf);
  });
});

describe("pane slice: splitPane", () => {
  beforeEach(resetStore);

  it("splits a leaf into a 50/50 horizontal split and focuses the new leaf", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    const newLeaf = useAppStore.getState().splitPane(1, rootLeaf, "horizontal");
    expect(newLeaf).not.toBeNull();
    const tree = useAppStore.getState().terminalPaneTrees[1];
    if (tree.kind !== "split") throw new Error("expected split");
    expect(tree.direction).toBe("horizontal");
    expect(tree.sizes).toEqual([50, 50]);
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBe(newLeaf);
  });

  it("refuses to split past the maximum leaf cap", () => {
    useAppStore.setState({ terminalPaneMaxLeaves: 2 });
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    expect(useAppStore.getState().splitPane(1, rootLeaf, "horizontal")).not.toBeNull();
    const active = useAppStore.getState().activeTerminalPaneId[1];
    // At 2 leaves with cap=2, any further split should be refused.
    expect(useAppStore.getState().splitPane(1, active, "horizontal")).toBeNull();
  });

  it("returns null when the tab has no tree yet", () => {
    expect(useAppStore.getState().splitPane(99, "missing", "horizontal")).toBeNull();
  });
});

describe("pane slice: closePane", () => {
  beforeEach(resetStore);

  it("collapses the split and focuses the surviving leaf", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    const newLeaf = useAppStore.getState().splitPane(1, rootLeaf, "horizontal");
    const promoted = useAppStore.getState().closePane(1, newLeaf!);
    expect(promoted).toBe(rootLeaf);
    expect(useAppStore.getState().terminalPaneTrees[1]).toEqual({
      kind: "leaf",
      id: rootLeaf,
    });
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBe(rootLeaf);
  });

  it("refuses to close the sole leaf", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    const result = useAppStore.getState().closePane(1, rootLeaf);
    expect(result).toBeNull();
    expect(useAppStore.getState().terminalPaneTrees[1]).toEqual({
      kind: "leaf",
      id: rootLeaf,
    });
  });
});

describe("pane slice: setPaneSizes", () => {
  beforeEach(resetStore);

  it("persists the new percentages for the given split", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    useAppStore.getState().splitPane(1, rootLeaf, "horizontal");
    const tree = useAppStore.getState().terminalPaneTrees[1];
    if (tree.kind !== "split") throw new Error("expected split");
    useAppStore.getState().setPaneSizes(1, tree.id, [30, 70]);
    const next = useAppStore.getState().terminalPaneTrees[1];
    if (next.kind !== "split") throw new Error("expected split");
    expect(next.sizes).toEqual([30, 70]);
  });
});

describe("pane slice: setPanePtyId / setPaneSpawnError", () => {
  beforeEach(resetStore);

  it("stores the ptyId and clears any prior spawnError on the target leaf", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    useAppStore.getState().setPaneSpawnError(1, rootLeaf, "boom");
    useAppStore.getState().setPanePtyId(1, rootLeaf, 42);
    const tree = useAppStore.getState().terminalPaneTrees[1];
    if (tree.kind !== "leaf") throw new Error("expected leaf");
    expect(tree.ptyId).toBe(42);
    expect(tree.spawnError).toBeNull();
  });

  it("records a spawn error and clears any stored ptyId", () => {
    const rootLeaf = useAppStore.getState().ensurePaneTree(1);
    useAppStore.getState().setPanePtyId(1, rootLeaf, 42);
    useAppStore.getState().setPaneSpawnError(1, rootLeaf, "no shell");
    const tree = useAppStore.getState().terminalPaneTrees[1];
    if (tree.kind !== "leaf") throw new Error("expected leaf");
    expect(tree.ptyId).toBeUndefined();
    expect(tree.spawnError).toBe("no shell");
  });
});

describe("pane slice: cleanup on tab/workspace removal", () => {
  beforeEach(resetStore);

  it("removeTerminalTab drops the tab's pane tree and active-pane entry", () => {
    const tab = makeTab(10);
    useAppStore.getState().addTerminalTab(WS, tab);
    useAppStore.getState().ensurePaneTree(10);
    expect(useAppStore.getState().terminalPaneTrees[10]).toBeDefined();
    useAppStore.getState().removeTerminalTab(WS, 10);
    expect(useAppStore.getState().terminalPaneTrees[10]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalPaneId[10]).toBeUndefined();
  });

  it("removeTerminalTab hides the terminal panel when the last tab closes", () => {
    useAppStore.setState({ selectedWorkspaceId: WS });
    useAppStore.getState().addTerminalTab(WS, makeTab(10));
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
    useAppStore.getState().removeTerminalTab(WS, 10);
    expect(useAppStore.getState().terminalPanelVisible).toBe(false);
    expect(useAppStore.getState().terminalTabs[WS]).toEqual([]);
  });

  it("removeTerminalTab keeps the panel visible when other tabs remain", () => {
    useAppStore.setState({ selectedWorkspaceId: WS });
    useAppStore.getState().addTerminalTab(WS, makeTab(10));
    useAppStore.getState().addTerminalTab(WS, makeTab(11));
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
    useAppStore.getState().removeTerminalTab(WS, 10);
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
  });

  // A user could close the last tab of a background workspace — e.g. a
  // plugin or external flow. We shouldn't yank the panel out from under
  // the currently-selected workspace just because some other workspace
  // went empty.
  it("removeTerminalTab does not hide the panel when the empty tab list belongs to a different workspace", () => {
    const OTHER_WS = "other-workspace";
    useAppStore.setState({ selectedWorkspaceId: WS });
    useAppStore.getState().addTerminalTab(WS, makeTab(10));
    useAppStore.getState().addTerminalTab(OTHER_WS, makeTab(20, OTHER_WS));
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
    useAppStore.getState().removeTerminalTab(OTHER_WS, 20);
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
  });

  it("removeWorkspace drops pane trees for every tab in the workspace", () => {
    // Seed workspace + two tabs with pane trees.
    useAppStore.setState({
      workspaces: [
        {
          id: WS,
          repository_id: "repo-x",
          name: "ws",
          worktree_path: "/tmp/ws",
          branch_name: "main",
          base_branch: "main",
          status: "active",
          agent_status: "idle",
          created_at: "",
          updated_at: "",
        } as unknown as import("../types").Workspace,
      ],
    });
    useAppStore.getState().addTerminalTab(WS, makeTab(1));
    useAppStore.getState().addTerminalTab(WS, makeTab(2));
    useAppStore.getState().ensurePaneTree(1);
    useAppStore.getState().ensurePaneTree(2);

    useAppStore.getState().removeWorkspace(WS);

    expect(useAppStore.getState().terminalPaneTrees[1]).toBeUndefined();
    expect(useAppStore.getState().terminalPaneTrees[2]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalPaneId[1]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalPaneId[2]).toBeUndefined();
  });
});
