import { beforeEach, describe, expect, it } from "vitest";
import {
  applyPersistedViewState,
  buildPersistedViewState,
  type PersistedViewStateV1,
} from "./useViewTogglePersistence";
import { fileBufferKey } from "../stores/slices/fileTreeSlice";
import { useAppStore } from "../stores/useAppStore";
import type { Workspace } from "../types";

function makeWorkspace(
  id: string,
  status: Workspace["status"] = "Active",
  repositoryId = "repo-1",
): Workspace {
  return {
    id,
    repository_id: repositoryId,
    name: `workspace-${id}`,
    branch_name: "main",
    worktree_path: `/tmp/${id}`,
    status,
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-01-01T00:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
  };
}

function makePersistedState(
  overrides: Partial<PersistedViewStateV1> = {},
): PersistedViewStateV1 {
  return {
    version: 1,
    sidebarVisible: true,
    rightSidebarVisible: false,
    terminalPanelVisible: false,
    sidebarWidth: 260,
    rightSidebarWidth: 250,
    terminalHeight: 300,
    rightSidebarTab: "files",
    sidebarGroupBy: "repo",
    sidebarRepoFilter: "all",
    sidebarShowArchived: false,
    selectedWorkspaceId: null,
    selectedSessionIdByWorkspaceId: {},
    repoCollapsed: {},
    statusGroupCollapsed: {},
    allFilesExpandedDirsByWorkspace: {},
    allFilesSelectedPathByWorkspace: {},
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    diffTabsByWorkspace: {},
    diffSelectionByWorkspace: {},
    tabOrderByWorkspace: {},
    activeTerminalTabId: {},
    terminalPaneTrees: {},
    activeTerminalPaneId: {},
    ...overrides,
  };
}

function resetStore() {
  useAppStore.setState({
    selectedWorkspaceId: null,
    selectedSessionIdByWorkspaceId: {},
    sidebarVisible: true,
    rightSidebarVisible: false,
    terminalPanelVisible: false,
    sidebarWidth: 260,
    rightSidebarWidth: 250,
    terminalHeight: 300,
    rightSidebarTab: "files",
    sidebarGroupBy: "repo",
    sidebarRepoFilter: "all",
    sidebarShowArchived: false,
    repoCollapsed: {},
    statusGroupCollapsed: {},
    allFilesExpandedDirsByWorkspace: {},
    allFilesSelectedPathByWorkspace: {},
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileBuffers: {},
    diffTabsByWorkspace: {},
    diffSelectionByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    diffContent: null,
    diffError: null,
    tabOrderByWorkspace: {},
    activeTerminalTabId: {},
    terminalPaneTrees: {},
    activeTerminalPaneId: {},
  });
}

describe("view state persistence", () => {
  beforeEach(resetStore);

  it("serializes UI state without unsaved file buffers or live PTY fields", () => {
    const key = fileBufferKey("ws-a", "src/main.ts");
    useAppStore.setState({
      selectedWorkspaceId: "ws-a",
      fileTabsByWorkspace: { "ws-a": ["src/main.ts"] },
      activeFileTabByWorkspace: { "ws-a": "src/main.ts" },
      fileBuffers: {
        [key]: {
          baseline: "saved",
          buffer: "unsaved edit",
          isBinary: false,
          sizeBytes: 5,
          truncated: false,
          imageBytesB64: null,
          loaded: true,
          loadError: null,
          preview: "source",
        },
      },
      terminalPaneTrees: {
        9: { kind: "leaf", id: "leaf-1", ptyId: 44, spawnError: "boom" },
      },
      activeTerminalPaneId: { 9: "leaf-1" },
    });

    const persisted = buildPersistedViewState(useAppStore.getState());
    expect(JSON.stringify(persisted)).not.toContain("unsaved edit");
    expect(persisted.terminalPaneTrees[9]).toEqual({
      kind: "leaf",
      id: "leaf-1",
    });
  });

  it("hydrates valid workspace tabs and reloads file tabs as unloaded buffers", () => {
    applyPersistedViewState(
      makePersistedState({
        selectedWorkspaceId: "ws-a",
        selectedSessionIdByWorkspaceId: { "ws-a": "session-2" },
        rightSidebarVisible: true,
        terminalPanelVisible: true,
        fileTabsByWorkspace: { "ws-a": ["src/main.ts"] },
        activeFileTabByWorkspace: { "ws-a": "src/main.ts" },
        diffTabsByWorkspace: {
          "ws-a": [{ path: "src/main.ts", layer: "unstaged" }],
        },
        diffSelectionByWorkspace: {
          "ws-a": { path: "src/main.ts", layer: "unstaged" },
        },
        tabOrderByWorkspace: {
          "ws-a": [
            { kind: "session", sessionId: "session-2" },
            { kind: "file", path: "src/main.ts" },
          ],
        },
        activeTerminalTabId: { "ws-a": 7 },
        terminalPaneTrees: {
          7: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              { kind: "leaf", id: "leaf-1" },
              { kind: "leaf", id: "leaf-2" },
            ],
            sizes: [35, 65],
          },
        },
        activeTerminalPaneId: { 7: "leaf-2" },
      }),
      [makeWorkspace("ws-a")],
    );

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-a");
    expect(state.selectedSessionIdByWorkspaceId["ws-a"]).toBe("session-2");
    expect(state.activeFileTabByWorkspace["ws-a"]).toBe("src/main.ts");
    expect(state.diffSelectedFile).toBeNull();
    expect(state.fileBuffers[fileBufferKey("ws-a", "src/main.ts")]).toMatchObject({
      loaded: false,
      baseline: "",
      buffer: "",
    });
    expect(state.activeTerminalTabId["ws-a"]).toBe(7);
    expect(state.activeTerminalPaneId[7]).toBe("leaf-2");
  });

  it("drops stale workspace-scoped state and falls back to the dashboard", () => {
    applyPersistedViewState(
      makePersistedState({
        selectedWorkspaceId: "missing",
        selectedSessionIdByWorkspaceId: {
          missing: "session-missing",
          archived: "session-archived",
        },
        fileTabsByWorkspace: {
          missing: ["dead.ts"],
          archived: ["archived.ts"],
        },
        activeFileTabByWorkspace: {
          missing: "dead.ts",
          archived: "archived.ts",
        },
        activeTerminalTabId: {
          missing: 1,
          archived: 2,
        },
      }),
      [makeWorkspace("live"), makeWorkspace("archived", "Archived")],
    );

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBeNull();
    expect(state.selectedSessionIdByWorkspaceId).toEqual({});
    expect(state.fileTabsByWorkspace).toEqual({});
    expect(state.activeFileTabByWorkspace).toEqual({});
    expect(state.activeTerminalTabId).toEqual({});
  });

  it("keeps repo filters only when the repository still has active workspaces", () => {
    applyPersistedViewState(
      makePersistedState({
        sidebarRepoFilter: "repo-live",
      }),
      [makeWorkspace("live", "Active", "repo-live")],
    );
    expect(useAppStore.getState().sidebarRepoFilter).toBe("repo-live");

    applyPersistedViewState(
      makePersistedState({
        sidebarRepoFilter: "repo-archived",
      }),
      [makeWorkspace("archived", "Archived", "repo-archived")],
    );
    expect(useAppStore.getState().sidebarRepoFilter).toBe("all");
  });

  it("drops stale collapsed repo and status group state", () => {
    applyPersistedViewState(
      makePersistedState({
        repoCollapsed: {
          "repo-live": true,
          "repo-archived": true,
          "repo-stale": true,
        },
        statusGroupCollapsed: {
          "status:merged": true,
          "status:archived": false,
          "status:unknown": true,
        },
      }),
      [
        makeWorkspace("live", "Active", "repo-live"),
        makeWorkspace("archived", "Archived", "repo-archived"),
      ],
    );

    const state = useAppStore.getState();
    expect(state.repoCollapsed).toEqual({ "repo-live": true });
    expect(state.statusGroupCollapsed).toEqual({
      "status:merged": true,
      "status:archived": false,
    });
  });

  it("does not resurrect a stale diff selection when current view is chat", () => {
    useAppStore.setState({
      selectedWorkspaceId: "ws-a",
      diffTabsByWorkspace: {
        "ws-a": [{ path: "src/main.ts", layer: "unstaged" }],
      },
      diffSelectionByWorkspace: {
        "ws-a": { path: "src/main.ts", layer: "unstaged" },
      },
      diffSelectedFile: null,
      diffSelectedLayer: null,
    });

    const persisted = buildPersistedViewState(useAppStore.getState());
    expect(persisted.diffSelectionByWorkspace["ws-a"]).toBeUndefined();
  });
});
