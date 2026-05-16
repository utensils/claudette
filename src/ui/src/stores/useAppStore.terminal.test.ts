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

  // Regression: once the user has dismissed the panel, adding a tab in
  // the background must not force the panel back open. The tab still
  // shows up in the panel's tab list the next time the user opens it.
  it("does not auto-show the panel when the user has dismissed it", () => {
    useAppStore.setState({
      terminalPanelVisible: false,
      terminalPanelUserDismissed: true,
    });
    useAppStore.getState().addTerminalTab(WS_A, makeTab(1, WS_A));
    expect(useAppStore.getState().terminalPanelVisible).toBe(false);
    // The tab itself still landed in state.
    expect(useAppStore.getState().terminalTabs[WS_A]).toHaveLength(1);
  });
});

describe("terminal slice: user-dismissal tracking", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalPanelVisible: false,
      terminalPanelUserDismissed: false,
      pendingTerminalCommands: [],
    });
  });

  it("toggleTerminalPanel sets dismissed=true when closing", () => {
    useAppStore.setState({ terminalPanelVisible: true });
    useAppStore.getState().toggleTerminalPanel();
    expect(useAppStore.getState().terminalPanelVisible).toBe(false);
    expect(useAppStore.getState().terminalPanelUserDismissed).toBe(true);
  });

  it("toggleTerminalPanel clears dismissed when opening", () => {
    useAppStore.setState({
      terminalPanelVisible: false,
      terminalPanelUserDismissed: true,
    });
    useAppStore.getState().toggleTerminalPanel();
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
    expect(useAppStore.getState().terminalPanelUserDismissed).toBe(false);
  });

  it("setTerminalPanelVisible(false) sets dismissed=true", () => {
    useAppStore.setState({ terminalPanelVisible: true });
    useAppStore.getState().setTerminalPanelVisible(false);
    expect(useAppStore.getState().terminalPanelUserDismissed).toBe(true);
  });

  it("setTerminalPanelVisible(true) clears dismissed", () => {
    useAppStore.setState({ terminalPanelUserDismissed: true });
    useAppStore.getState().setTerminalPanelVisible(true);
    expect(useAppStore.getState().terminalPanelUserDismissed).toBe(false);
  });

  // "Run in terminal" is an explicit user action — it surfaces the
  // panel even if the user had previously dismissed it.
  it("enqueueTerminalCommand opens the panel and clears the dismissal", () => {
    useAppStore.setState({
      terminalPanelVisible: false,
      terminalPanelUserDismissed: true,
    });
    useAppStore.getState().enqueueTerminalCommand(WS_A, "ls -la");
    expect(useAppStore.getState().terminalPanelVisible).toBe(true);
    expect(useAppStore.getState().terminalPanelUserDismissed).toBe(false);
  });
});

describe("terminal slice: upsertAgentTaskTerminalTab", () => {
  beforeEach(() => {
    useAppStore.setState({
      terminalTabs: {},
      activeTerminalTabId: { [WS_A]: 99 },
      terminalPanelVisible: false,
      agentBackgroundTasksBySessionId: {},
    });
  });

  it("registers agent task tabs without opening or stealing the terminal", () => {
    const tab: TerminalTab = {
      ...makeTab(10, WS_A),
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      agent_tool_use_id: "toolu_1",
      task_status: "running",
    };

    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", tab);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([tab]);
    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-a"],
    ).toEqual([tab]);
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(99);
    expect(useAppStore.getState().terminalPanelVisible).toBe(false);
  });

  it("updates an existing agent task tab in place", () => {
    const running: TerminalTab = {
      ...makeTab(10, WS_A),
      kind: "agent_task",
      task_status: "running",
    };
    const completed: TerminalTab = {
      ...running,
      task_status: "completed",
      task_summary: "done",
    };

    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", running);
    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", completed);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([completed]);
    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-a"],
    ).toEqual([completed]);
  });

  it("replaces prior agent tabs for the same session but preserves other sessions", () => {
    const previousSameSession: TerminalTab = {
      ...makeTab(10, WS_A),
      title: "Agent: sleep 30",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      task_status: "running",
    };
    const otherSession: TerminalTab = {
      ...makeTab(11, WS_A),
      title: "Claudette terminal",
      kind: "agent_task",
      agent_chat_session_id: "session-b",
      task_status: "running",
    };
    const replacement: TerminalTab = {
      ...makeTab(12, WS_A),
      title: "Claudette terminal",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      task_status: "running",
    };

    useAppStore
      .getState()
      .setTerminalTabs(WS_A, [previousSameSession, otherSession]);
    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", replacement);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([
      otherSession,
      replacement,
    ]);
    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-a"],
    ).toEqual([replacement]);
    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-b"],
    ).toBeUndefined();
  });

  it("defaults the read-only agent terminal first and replaces legacy command tabs", () => {
    const userTerminal = makeTab(1, WS_A);
    const legacyAgentTab: TerminalTab = {
      ...makeTab(2, WS_A),
      title: "Agent: sleep 30 && date",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      task_status: "running",
    };
    const claudetteTerminal: TerminalTab = {
      ...makeTab(3, WS_A),
      sort_order: 0,
      title: "Claudette terminal",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      task_status: "running",
    };

    useAppStore.getState().setTerminalTabs(WS_A, [userTerminal, legacyAgentTab]);
    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", claudetteTerminal);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([
      claudetteTerminal,
      userTerminal,
    ]);
    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-a"],
    ).toEqual([claudetteTerminal]);
  });

  it("preserves explicit user tab order even when an agent terminal is present", () => {
    const userTerminal = { ...makeTab(1, WS_A), sort_order: 0 };
    const claudetteTerminal: TerminalTab = {
      ...makeTab(2, WS_A),
      sort_order: 1,
      title: "Claudette terminal",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
    };

    useAppStore
      .getState()
      .setTerminalTabs(WS_A, [claudetteTerminal, userTerminal]);

    expect(useAppStore.getState().terminalTabs[WS_A]).toEqual([
      userTerminal,
      claudetteTerminal,
    ]);
  });

  it("preserves a reordered agent terminal after the user drags it", () => {
    const userTerminal = { ...makeTab(1, WS_A), sort_order: 0 };
    const claudetteTerminal: TerminalTab = {
      ...makeTab(2, WS_A),
      sort_order: 1,
      title: "Claudette terminal",
      kind: "agent_task",
      agent_chat_session_id: "session-a",
    };

    useAppStore
      .getState()
      .setTerminalTabs(WS_A, [claudetteTerminal, userTerminal]);

    expect(useAppStore.getState().terminalTabs[WS_A].map((tab) => tab.id)).toEqual([
      1,
      2,
    ]);
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

  it("when removing the leftmost active tab, activates the new first (right neighbor) tab", () => {
    useAppStore.getState().setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 1);

    useAppStore.getState().removeTerminalTab(WS_A, 1);

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(2);
  });

  it("when removing a non-leftmost active tab, activates the left neighbor", () => {
    useAppStore
      .getState()
      .setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A), makeTab(3, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 2);

    useAppStore.getState().removeTerminalTab(WS_A, 2);

    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBe(1);
  });

  it("when removing the rightmost active tab, activates the left neighbor", () => {
    useAppStore
      .getState()
      .setTerminalTabs(WS_A, [makeTab(1, WS_A), makeTab(2, WS_A), makeTab(3, WS_A)]);
    useAppStore.getState().setActiveTerminalTab(WS_A, 3);

    useAppStore.getState().removeTerminalTab(WS_A, 3);

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

  it("removing an agent tab clears its tracked background task entry", () => {
    const agentTab: TerminalTab = {
      ...makeTab(10, WS_A),
      kind: "agent_task",
      agent_chat_session_id: "session-a",
      task_status: "running",
    };
    useAppStore
      .getState()
      .upsertAgentTaskTerminalTab(WS_A, "session-a", agentTab);

    useAppStore.getState().removeTerminalTab(WS_A, 10);

    expect(
      useAppStore.getState().agentBackgroundTasksBySessionId["session-a"],
    ).toBeUndefined();
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
        [WS_A]: { 1: "cargo test" },
      },
      pendingTerminalCommands: [
        { id: "cmd-a", workspaceId: WS_A, command: "cargo test" },
        { id: "cmd-b", workspaceId: WS_B, command: "git status" },
      ],
    });

    useAppStore.getState().removeWorkspace(WS_A);

    expect(useAppStore.getState().terminalTabs[WS_A]).toBeUndefined();
    expect(useAppStore.getState().activeTerminalTabId[WS_A]).toBeUndefined();
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toBeUndefined();
    expect(useAppStore.getState().pendingTerminalCommands).toEqual([
      { id: "cmd-b", workspaceId: WS_B, command: "git status" },
    ]);
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
        [WS_A]: { 1: "make build" },
        [WS_B]: { 2: "npm test" },
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

describe("workspace running-command map", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaceTerminalCommands: {},
    });
  });

  it("setWorkspaceRunningCommand records a command under workspace+pty", () => {
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 1, "sleep 30");
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toEqual({
      1: "sleep 30",
    });
  });

  it("setWorkspaceRunningCommand allows multiple PTYs per workspace", () => {
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 1, "cargo test");
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 2, "bun run dev");
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toEqual({
      1: "cargo test",
      2: "bun run dev",
    });
  });

  it("setWorkspaceRunningCommand isolates workspaces from each other", () => {
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 1, "make build");
    useAppStore.getState().setWorkspaceRunningCommand(WS_B, 1, "npm test");
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toEqual({
      1: "make build",
    });
    expect(useAppStore.getState().workspaceTerminalCommands[WS_B]).toEqual({
      1: "npm test",
    });
  });

  it("clearWorkspaceRunningCommand removes only the named pty entry", () => {
    useAppStore.setState({
      workspaceTerminalCommands: { [WS_A]: { 1: "a", 2: "b" } },
    });
    useAppStore.getState().clearWorkspaceRunningCommand(WS_A, 1);
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toEqual({
      2: "b",
    });
  });

  it("clearWorkspaceRunningCommand drops the workspace key when its map empties", () => {
    useAppStore.setState({
      workspaceTerminalCommands: { [WS_A]: { 1: "only" } },
    });
    useAppStore.getState().clearWorkspaceRunningCommand(WS_A, 1);
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toBeUndefined();
  });

  it("clearWorkspaceRunningCommand on a missing entry is a no-op", () => {
    const before = useAppStore.getState().workspaceTerminalCommands;
    useAppStore.getState().clearWorkspaceRunningCommand("missing-ws", 999);
    expect(useAppStore.getState().workspaceTerminalCommands).toBe(before);
  });

  it("setWorkspaceRunningCommand replaces an existing entry for the same pty", () => {
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 1, "first");
    useAppStore.getState().setWorkspaceRunningCommand(WS_A, 1, "second");
    expect(useAppStore.getState().workspaceTerminalCommands[WS_A]).toEqual({
      1: "second",
    });
  });
});

describe("terminal command queue", () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingTerminalCommands: [],
      terminalPanelVisible: false,
    });
  });

  it("enqueueTerminalCommand opens the panel and queues a command", () => {
    useAppStore.getState().enqueueTerminalCommand(WS_A, "git status");

    const state = useAppStore.getState();
    expect(state.terminalPanelVisible).toBe(true);
    expect(state.pendingTerminalCommands).toHaveLength(1);
    expect(state.pendingTerminalCommands[0]).toMatchObject({
      workspaceId: WS_A,
      command: "git status",
    });
  });

  it("completeTerminalCommand removes only the matching command", () => {
    useAppStore.getState().enqueueTerminalCommand(WS_A, "one");
    useAppStore.getState().enqueueTerminalCommand(WS_A, "two");
    const firstId = useAppStore.getState().pendingTerminalCommands[0]?.id;

    expect(firstId).toBeTruthy();
    useAppStore.getState().completeTerminalCommand(firstId!);

    expect(useAppStore.getState().pendingTerminalCommands).toHaveLength(1);
    expect(useAppStore.getState().pendingTerminalCommands[0]?.command).toBe("two");
  });
});

describe("showSidebarRunningCommands setting", () => {
  beforeEach(() => {
    useAppStore.setState({ showSidebarRunningCommands: false });
  });

  it("defaults to false", () => {
    expect(useAppStore.getState().showSidebarRunningCommands).toBe(false);
  });

  it("setShowSidebarRunningCommands toggles the flag", () => {
    useAppStore.getState().setShowSidebarRunningCommands(true);
    expect(useAppStore.getState().showSidebarRunningCommands).toBe(true);
    useAppStore.getState().setShowSidebarRunningCommands(false);
    expect(useAppStore.getState().showSidebarRunningCommands).toBe(false);
  });
});
