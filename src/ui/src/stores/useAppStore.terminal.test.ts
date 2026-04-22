import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { TerminalTab } from "../types/terminal";

const WS_A = "workspace-a";
const WS_B = "workspace-b";

function makeTab(id: number, workspaceId: string): TerminalTab {
  return {
    id,
    workspace_id: workspaceId,
    title: `Terminal ${id}`,
    is_script_output: false,
    sort_order: id,
    created_at: "",
  };
}

describe("terminal slice: activeTerminalTabId is workspace-scoped", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalTabs: {},
      activeTerminalTabId: {},
    });
  });

  it("setActiveTerminalTab writes under the given workspace key", () => {
    useAppStore.getState().setActiveTerminalTab(WS_A, 42);
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(42);
  });

  it("does not pollute sibling workspaces", () => {
    useAppStore.getState().setActiveTerminalTab(WS_A, 42);
    useAppStore.getState().setActiveTerminalTab(WS_B, 7);
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(42);
    expect(useAppStore.getState().activeTerminalTabId[WS_B]).toBe(7);
  });

  it("setActiveTerminalTab(null) clears the active tab for that workspace", () => {
    useAppStore.getState().setActiveTerminalTab(WS_A, 42);
    useAppStore.getState().setActiveTerminalTab(WS_A, null);
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBeNull();
  });
});

describe("terminal slice: addTerminalTab", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalTabs: {},
      activeTerminalTabId: {},
      terminalPanelVisible: false,
    });
  });

  it("appends the tab and sets it active for that workspace", () => {
    const tab = makeTab(10, WS_A);
    useAppStore.getState().addTerminalTab(WS_A, tab);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([tab]);
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(10);
  });

  it("adding to workspace A does not change workspace B's active tab", () => {
    useAppStore.getState().addTerminalTab(WS_A, makeTab(1, WS_A));
    useAppStore.getState().setActiveTerminalTab(WS_B, 99);

    useAppStore.getState().addTerminalTab(WS_A, makeTab(2, WS_A));

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(2);
    expect(useAppStore.getState().activeTerminalTabId[WS_B]).toBe(99);
  });

  it("auto-shows the terminal panel", () => {
    useAppStore.getState().addTerminalTab(WS_A, makeTab(1, WS_A));
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
  });
});

describe("terminal slice: removeTerminalTab", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalTabs: {},
      activeTerminalTabId: {},
    });
  });

  it("removes the tab from its workspace", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    const remaining = useAppStore.getState().terminalTabs[WS_A];
    expect(remaining.map((t) => t.id)).toEqual([2]);
  });

  it("when removing the active tab, falls back to the first remaining tab in that workspace", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(2);
  });

  it("when removing the active tab and none remain, sets the workspace's active to null", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBeNull();
  });

  it("removing a non-active tab does not change the active id", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 2);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(2);
  });

  it("does not touch another workspace's active tab", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);
    useAppStore.getState().setActiveTerminalTab(WS_B, 99);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().activeTerminalTabId[WS_B]).toBe(99);
  });

  it("auto-hides the pane when the selected workspace's last tab is closed", () => {
    useAppStore.setState({
      selectedWorkspaceId: WS_A,
      terminalPanelVisible: true,
    });
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().terminalPanelVisible).toBe(false);
  });

  it("does not hide the pane when tabs remain in the selected workspace", () => {
    useAppStore.setState({
      selectedWorkspaceId: WS_A,
      terminalPanelVisible: true,
    });
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A)]);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
  });

  it("does not hide the pane when the affected workspace is not selected", () => {
    useAppStore.setState({
      selectedWorkspaceId: WS_B,
      terminalPanelVisible: true,
    });
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A)]);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
  });
});

describe("workspace removal cascades to terminal state", () => {
  beforeEach(() => {
    useAppStore.setState({
      repositories: [],
      workspaces: [],
      terminalTabs: {},
      activeTerminalTabId: {},
      workspaceTerminalCommands: {},
      unreadCompletions: new Set<string>(),
      selectedWorkspaceId: null,
    });
  });

  it("removeWorkspace drops terminalTabs, activeTerminalTabId, and workspaceTerminalCommands", () => {
    useAppStore.setState({
      workspaces: [
        {
          id: WS_A,
          repository_id: "repo-1",
          name: "ws-a",
          branch: "main",
          worktree_path: "/tmp/a",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
      ],
      terminalTabs: { [WS_A]: [makeTab(1, WS_A)] },
      activeTerminalTabId: { [WS_A]: 1 },
      workspaceTerminalCommands: {
        [WS_A]: { command: "cargo test", isRunning: true, exitCode: null },
      },
    });

    useAppStore.getState().removeWorkspace(WS_A);

    expect(useAppStore.getState().terminalTabs[WS_A]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBeUndefined();
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toBeUndefined();
  });

  it("removeRepository cascades through its workspaces' terminal state", () => {
    useAppStore.setState({
      repositories: [
        { id: "repo-1", name: "r", root_path: "/r" } as never,
      ],
      workspaces: [
        {
          id: WS_A,
          repository_id: "repo-1",
          name: "a",
          branch: "main",
          worktree_path: "/tmp/a",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
        {
          id: WS_B,
          repository_id: "repo-1",
          name: "b",
          branch: "main",
          worktree_path: "/tmp/b",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
      ],
      terminalTabs: {
        [WS_A]: [makeTab(1, WS_A)],
        [WS_B]: [makeTab(2, WS_B)],
      },
      activeTerminalTabId: { [WS_A]: 1, [WS_B]: 2 },
      workspaceTerminalCommands: {
        [WS_A]: { command: null, isRunning: false, exitCode: null },
        [WS_B]: { command: null, isRunning: false, exitCode: null },
      },
    });

    useAppStore.getState().removeRepository("repo-1");

    expect(useAppStore.getState().terminalTabs[WS_A]).toBeUndefined();
    expect(useAppStore.getState().terminalTabs[WS_B]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalTabId[WS_B]).toBeUndefined();
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toBeUndefined();
    expect(useAppStore.getState().workspaceTerminalCommands[WS_B]).toBeUndefined();
  });

  it("removeRepository deselects a workspace that belonged to the removed repo", () => {
    useAppStore.setState({
      repositories: [
        { id: "repo-1", name: "r", root_path: "/r" } as never,
      ],
      workspaces: [
        {
          id: WS_A,
          repository_id: "repo-1",
          name: "a",
          branch: "main",
          worktree_path: "/tmp/a",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
      ],
      selectedWorkspaceId: WS_A,
      unreadCompletions: new Set([WS_A]),
    });

    useAppStore.getState().removeRepository("repo-1");

    expect(useAppStore.getState().selectedWorkspaceId).toBeNull();
    // unreadCompletions entry for the removed workspace should also go.
    expect(useAppStore.getState().unreadCompletions.has(WS_A)).toBe(false);
  });

  it("removeRepository preserves selectedWorkspaceId when it belongs to another repo", () => {
    useAppStore.setState({
      repositories: [
        { id: "repo-1", name: "r1", root_path: "/r1" } as never,
        { id: "repo-2", name: "r2", root_path: "/r2" } as never,
      ],
      workspaces: [
        {
          id: WS_A,
          repository_id: "repo-1",
          name: "a",
          branch: "main",
          worktree_path: "/tmp/a",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
        {
          id: WS_B,
          repository_id: "repo-2",
          name: "b",
          branch: "main",
          worktree_path: "/tmp/b",
          status: "Active",
          created_at: "",
          agent_status: "Idle",
          remote_connection_id: null,
        } as never,
      ],
      selectedWorkspaceId: WS_B,
    });

    useAppStore.getState().removeRepository("repo-1");

    // repo-2's workspace is still selected — removing repo-1 shouldn't affect it.
    expect(useAppStore.getState().selectedWorkspaceId).toBe(WS_B);
  });
});
