import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

const WS_A = "workspace-a";
const WS_B = "workspace-b";

// Minimal reset so each case starts from a known empty state.
function reset() {
  useAppStore.setState({
    diffTabsByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    diffContent: null,
    diffError: null,
    sessionsByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileBuffers: {},
  });
}

describe("openDiffTab", () => {
  beforeEach(reset);

  it("appends the tab and sets it active", () => {
    useAppStore.getState().openDiffTab(WS_A, "src/foo.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffTabsByWorkspace[WS_A]).toEqual([
      { path: "src/foo.ts", layer: "unstaged" },
    ]);
    expect(state.diffSelectedFile).toBe("src/foo.ts");
    expect(state.diffSelectedLayer).toBe("unstaged");
  });

  it("dedupes when re-opening the same (path, layer)", () => {
    useAppStore.getState().openDiffTab(WS_A, "src/foo.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "src/foo.ts", "unstaged");

    expect(useAppStore.getState().diffTabsByWorkspace[WS_A]).toHaveLength(1);
  });

  it("treats different layers of the same path as distinct tabs", () => {
    useAppStore.getState().openDiffTab(WS_A, "src/foo.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "src/foo.ts", "committed");

    const tabs = useAppStore.getState().diffTabsByWorkspace[WS_A];
    expect(tabs).toEqual([
      { path: "src/foo.ts", layer: "unstaged" },
      { path: "src/foo.ts", layer: "committed" },
    ]);
  });

  it("isolates tabs by workspace", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", null);
    useAppStore.getState().openDiffTab(WS_B, "b.ts", null);

    const state = useAppStore.getState();
    expect(state.diffTabsByWorkspace[WS_A]).toEqual([{ path: "a.ts", layer: null }]);
    expect(state.diffTabsByWorkspace[WS_B]).toEqual([{ path: "b.ts", layer: null }]);
  });

  it("treats omitted layer as null", () => {
    useAppStore.getState().openDiffTab(WS_A, "x.ts");
    useAppStore.getState().openDiffTab(WS_A, "x.ts", null);

    expect(useAppStore.getState().diffTabsByWorkspace[WS_A]).toHaveLength(1);
  });
});

describe("closeDiffTab", () => {
  beforeEach(reset);

  it("removes the tab from the strip", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "b.ts", "unstaged");

    useAppStore.getState().closeDiffTab(WS_A, "a.ts", "unstaged");

    expect(useAppStore.getState().diffTabsByWorkspace[WS_A]).toEqual([
      { path: "b.ts", layer: "unstaged" },
    ]);
  });

  it("clears active-diff state when closing the active tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.setState({ diffContent: { path: "a.ts", hunks: [], is_binary: false } });

    useAppStore.getState().closeDiffTab(WS_A, "a.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBeNull();
    expect(state.diffSelectedLayer).toBeNull();
    expect(state.diffContent).toBeNull();
  });

  it("preserves active-diff state when closing a non-active tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "b.ts", "unstaged");
    // a.ts is now non-active (b.ts opened last and became active).

    useAppStore.getState().closeDiffTab(WS_A, "a.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBe("b.ts");
    expect(state.diffSelectedLayer).toBe("unstaged");
  });

  it("is a no-op for an unknown (path, layer)", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    const before = useAppStore.getState().diffTabsByWorkspace[WS_A];

    useAppStore.getState().closeDiffTab(WS_A, "missing.ts", "unstaged");

    expect(useAppStore.getState().diffTabsByWorkspace[WS_A]).toBe(before);
  });
});

describe("selectDiffTab", () => {
  beforeEach(reset);

  it("focuses the diff without mutating the tab list", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "b.ts", "unstaged");
    const tabsBefore = useAppStore.getState().diffTabsByWorkspace[WS_A];

    useAppStore.getState().selectDiffTab("a.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBe("a.ts");
    expect(state.diffSelectedLayer).toBe("unstaged");
    expect(state.diffTabsByWorkspace[WS_A]).toBe(tabsBefore);
  });

  it("clears stale content/error when switching to a different tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_A, "b.ts", "unstaged");
    // Simulate a load completing for b.ts.
    useAppStore.setState({
      diffContent: { path: "b.ts", hunks: [], is_binary: false },
      diffError: "boom",
    });

    useAppStore.getState().selectDiffTab("a.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffContent).toBeNull();
    expect(state.diffError).toBeNull();
  });

  it("preserves content when re-selecting the already-active tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    const content = { path: "a.ts", hunks: [], is_binary: false };
    useAppStore.setState({ diffContent: content });

    useAppStore.getState().selectDiffTab("a.ts", "unstaged");

    expect(useAppStore.getState().diffContent).toBe(content);
  });
});

describe("openDiffTab clears stale content", () => {
  beforeEach(reset);

  it("nulls diffContent/diffError when opening a different file", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.setState({
      diffContent: { path: "a.ts", hunks: [], is_binary: false },
      diffError: "boom",
    });

    useAppStore.getState().openDiffTab(WS_A, "b.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.diffContent).toBeNull();
    expect(state.diffError).toBeNull();
  });

  it("preserves diffContent when re-opening the already-active tab", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    const content = { path: "a.ts", hunks: [], is_binary: false };
    useAppStore.setState({ diffContent: content });

    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");

    expect(useAppStore.getState().diffContent).toBe(content);
  });
});

describe("selectSession clears active diff", () => {
  beforeEach(reset);

  it("nulls diffSelectedFile so AppLayout swaps back to chat", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    expect(useAppStore.getState().diffSelectedFile).toBe("a.ts");

    useAppStore.getState().selectSession(WS_A, "session-1");

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBeNull();
    expect(state.diffSelectedLayer).toBeNull();
    // Diff tabs themselves remain in the strip.
    expect(state.diffTabsByWorkspace[WS_A]).toHaveLength(1);
    expect(state.selectedSessionIdByWorkspaceId[WS_A]).toBe("session-1");
  });
});

describe("workspace removal cleans up diff tabs", () => {
  beforeEach(reset);

  it("removeWorkspace drops the workspace's diff tabs", () => {
    useAppStore.setState({
      workspaces: [
        // Minimal stub — only fields touched by removeWorkspace matter here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: WS_A } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: WS_B } as any,
      ],
    });
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    useAppStore.getState().openDiffTab(WS_B, "b.ts", "unstaged");

    useAppStore.getState().removeWorkspace(WS_A);

    const state = useAppStore.getState();
    expect(state.diffTabsByWorkspace[WS_A]).toBeUndefined();
    expect(state.diffTabsByWorkspace[WS_B]).toEqual([
      { path: "b.ts", layer: "unstaged" },
    ]);
  });
});

// Regression for issue 573: opening a Changes-panel diff entry while a file tab
// is active in the FileViewer must release the file tab so AppLayout's
// "file viewer beats diff viewer" precedence stops blocking the diff. The
// fix lives in the slice so every caller of openDiffTab gets the right
// behavior automatically (previously only SessionTabs.switchToDiff
// remembered to call clearActiveFileTab — RightSidebar's row click forgot).
describe("openDiffTab releases the active file tab (issue 573)", () => {
  beforeEach(reset);

  it("clears activeFileTabByWorkspace[workspaceId] so the diff is visible", () => {
    useAppStore.getState().openFileTab(WS_A, "src/foo.ts");
    expect(useAppStore.getState().activeFileTabByWorkspace[WS_A]).toBe(
      "src/foo.ts",
    );

    useAppStore.getState().openDiffTab(WS_A, "src/bar.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.activeFileTabByWorkspace[WS_A]).toBeNull();
    expect(state.diffSelectedFile).toBe("src/bar.ts");
    expect(state.diffSelectedLayer).toBe("unstaged");
    // The file tab itself stays open in the strip so the user can switch
    // back; only the active pointer is released.
    expect(state.fileTabsByWorkspace[WS_A]).toEqual(["src/foo.ts"]);
  });

  it("does not touch other workspaces' active file tabs", () => {
    useAppStore.getState().openFileTab(WS_A, "src/a.ts");
    useAppStore.getState().openFileTab(WS_B, "src/b.ts");

    useAppStore.getState().openDiffTab(WS_A, "src/diff.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.activeFileTabByWorkspace[WS_A]).toBeNull();
    expect(state.activeFileTabByWorkspace[WS_B]).toBe("src/b.ts");
  });

  it("is a no-op when no file tab was active", () => {
    // Sanity: workspace has no open file tabs at all.
    useAppStore.getState().openDiffTab(WS_A, "src/bar.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.activeFileTabByWorkspace[WS_A] ?? null).toBeNull();
    expect(state.diffSelectedFile).toBe("src/bar.ts");
  });
});

// Baseline: the SessionTabs.switchToDiff path (clearActiveFileTab +
// selectDiffTab, in that order) was the only diff-navigation entry point
// that already honored the file-viewer release contract before issue 573. Keep
// a regression on it so a future refactor of switchToDiff can't silently
// break the working baseline.
describe("SessionTabs.switchToDiff baseline still releases the file tab", () => {
  beforeEach(reset);

  it("clearActiveFileTab + selectDiffTab leaves the diff visible", () => {
    useAppStore.getState().openFileTab(WS_A, "src/foo.ts");
    useAppStore.getState().openDiffTab(WS_A, "src/bar.ts", "unstaged");
    // Re-open the file tab to mimic the user clicking back to the file
    // viewer; that re-asserts activeFileTabByWorkspace[WS_A].
    useAppStore.getState().openFileTab(WS_A, "src/foo.ts");
    expect(useAppStore.getState().activeFileTabByWorkspace[WS_A]).toBe(
      "src/foo.ts",
    );

    // Mirror SessionTabs.switchToDiff exactly.
    useAppStore.getState().clearActiveFileTab(WS_A);
    useAppStore.getState().selectDiffTab("src/bar.ts", "unstaged");

    const state = useAppStore.getState();
    expect(state.activeFileTabByWorkspace[WS_A]).toBeNull();
    expect(state.diffSelectedFile).toBe("src/bar.ts");
  });
});

describe("selectWorkspace clears active diff pointer", () => {
  beforeEach(reset);

  it("nulls diffSelectedFile when switching workspaces but preserves per-workspace tabs", () => {
    useAppStore.getState().openDiffTab(WS_A, "a.ts", "unstaged");
    expect(useAppStore.getState().diffSelectedFile).toBe("a.ts");

    useAppStore.getState().selectWorkspace(WS_B);

    const state = useAppStore.getState();
    expect(state.diffSelectedFile).toBeNull();
    expect(state.diffSelectedLayer).toBeNull();
    // The original workspace's diff tab list is untouched.
    expect(state.diffTabsByWorkspace[WS_A]).toEqual([
      { path: "a.ts", layer: "unstaged" },
    ]);
  });

  it("clears diffMergeBase so the file viewer's git gutter cannot read the prior workspace's SHA", () => {
    // Regression for PR 602 review: the right sidebar's clearDiff() runs
    // on workspace switch only when the sidebar is mounted; when it's
    // hidden, the cached merge-base SHA leaked across the switch and the
    // file viewer's gutter would diff against the wrong workspace's base.
    //
    // Anchor the starting workspace so selectWorkspace's no-op guard
    // (`if (id === s.selectedWorkspaceId) return s;`) doesn't short-circuit
    // — earlier tests in this file may have left selectedWorkspaceId at WS_B.
    useAppStore.getState().selectWorkspace(WS_A);
    useAppStore.getState().setDiffMergeBase("a".repeat(40));
    expect(useAppStore.getState().diffMergeBase).not.toBeNull();

    useAppStore.getState().selectWorkspace(WS_B);

    expect(useAppStore.getState().diffMergeBase).toBeNull();
  });
});
