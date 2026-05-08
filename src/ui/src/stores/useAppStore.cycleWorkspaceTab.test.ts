import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { ChatSession } from "../types";

const WS_A = "workspace-a";

const session = (id: string, sortOrder = 0): ChatSession => ({
  id,
  workspace_id: WS_A,
  session_id: null,
  name: `s-${id}`,
  name_edited: false,
  turn_count: 0,
  sort_order: sortOrder,
  status: "Active",
  created_at: "2026-01-01T00:00:00Z",
  archived_at: null,
  cli_invocation: null,
  agent_status: "Idle",
  needs_attention: false,
  attention_kind: null,
});

// Minimal reset so each case starts from a known empty state.
function reset() {
  useAppStore.setState({
    selectedWorkspaceId: WS_A,
    sessionsByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
    diffTabsByWorkspace: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    tabOrderByWorkspace: {},
  });
}

describe("cycleWorkspaceTab", () => {
  beforeEach(reset);

  it("no-ops when no workspace is selected", () => {
    useAppStore.setState({ selectedWorkspaceId: null });
    useAppStore.getState().cycleWorkspaceTab("next");
    // Reaching here without a thrown error is enough — the action should
    // bail before touching any state.
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId).toEqual({});
  });

  it("no-ops when the strip has fewer than two entries", () => {
    useAppStore.setState({
      sessionsByWorkspace: { [WS_A]: [session("s1")] },
      selectedSessionIdByWorkspaceId: { [WS_A]: "s1" },
    });
    useAppStore.getState().cycleWorkspaceTab("next");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WS_A]).toBe("s1");
  });

  it("cycles between sessions with wrap-around", () => {
    useAppStore.setState({
      sessionsByWorkspace: { [WS_A]: [session("s1"), session("s2")] },
      selectedSessionIdByWorkspaceId: { [WS_A]: "s1" },
    });

    useAppStore.getState().cycleWorkspaceTab("next");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WS_A]).toBe("s2");

    // Wrap forward.
    useAppStore.getState().cycleWorkspaceTab("next");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WS_A]).toBe("s1");

    // Wrap backward.
    useAppStore.getState().cycleWorkspaceTab("prev");
    expect(useAppStore.getState().selectedSessionIdByWorkspaceId[WS_A]).toBe("s2");
  });

  it("cycles from a session into a diff tab and clears any active file tab", () => {
    useAppStore.setState({
      sessionsByWorkspace: { [WS_A]: [session("s1")] },
      selectedSessionIdByWorkspaceId: { [WS_A]: "s1" },
      diffTabsByWorkspace: { [WS_A]: [{ path: "a.ts", layer: "unstaged" }] },
      // A stale active file tab should be cleared when cycling into the
      // diff tab — otherwise the file viewer would visually win and the
      // diff tab's `isActive` would compute to false.
      fileTabsByWorkspace: { [WS_A]: ["x.ts"] },
      activeFileTabByWorkspace: { [WS_A]: "x.ts" },
    });

    useAppStore.getState().cycleWorkspaceTab("next");
    const state = useAppStore.getState();
    // Active file tab cleared so AppLayout drops out of the file viewer.
    expect(state.activeFileTabByWorkspace[WS_A]).toBeNull();
  });

  it("cycles into a file tab and sets it active", () => {
    useAppStore.setState({
      sessionsByWorkspace: { [WS_A]: [session("s1")] },
      selectedSessionIdByWorkspaceId: { [WS_A]: "s1" },
      fileTabsByWorkspace: { [WS_A]: ["x.ts"] },
      activeFileTabByWorkspace: { [WS_A]: null },
    });

    useAppStore.getState().cycleWorkspaceTab("next");
    expect(useAppStore.getState().activeFileTabByWorkspace[WS_A]).toBe("x.ts");
  });

  it("honors the saved unified tab order over the default per-kind order", () => {
    useAppStore.setState({
      sessionsByWorkspace: { [WS_A]: [session("s1"), session("s2")] },
      selectedSessionIdByWorkspaceId: { [WS_A]: "s1" },
      fileTabsByWorkspace: { [WS_A]: ["x.ts"] },
      // Visual order is x.ts → s2 → s1; from s1, "next" wraps to x.ts.
      tabOrderByWorkspace: {
        [WS_A]: [
          { kind: "file", path: "x.ts" },
          { kind: "session", sessionId: "s2" },
          { kind: "session", sessionId: "s1" },
        ],
      },
    });

    useAppStore.getState().cycleWorkspaceTab("next");
    expect(useAppStore.getState().activeFileTabByWorkspace[WS_A]).toBe("x.ts");
  });
});
