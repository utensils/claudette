import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatCloseConfirmKind,
  executeCloseTab,
  executeNewTab,
} from "./contextActions";
import { useAppStore } from "../stores/useAppStore";
import type { ChatSession, SessionAgentStatus } from "../types/chat";

const WS = "workspace-1";

function makeSession(
  id: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    workspace_id: WS,
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: new Date().toISOString(),
    archived_at: null,
    cli_invocation: null,
    agent_status: "Stopped" as SessionAgentStatus,
    needs_attention: false,
    attention_kind: null,
    ...overrides,
  };
}

/**
 * Reset the store to a known baseline. The slices we care about for
 * these tests are workspaces / chat sessions / file tabs / diff
 * selection / right-sidebar visibility — set them all explicitly so a
 * test exercising a single branch doesn't pick up stale state from
 * an earlier test in the same file.
 */
function resetStore() {
  useAppStore.setState({
    selectedWorkspaceId: WS,
    activeFileTabByWorkspace: {},
    fileTabsByWorkspace: {},
    sessionsByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
    diffSelectedFile: null,
    diffSelectedLayer: null,
    rightSidebarVisible: false,
    rightSidebarTab: "files",
    requestNewFileNonceByWorkspace: {},
    requestCloseFileTabNonceByWorkspace: {},
  });
}

describe("chatCloseConfirmKind", () => {
  // Pure routing logic — exercise every branch without touching the
  // store. The four kinds are priority-ordered (running > active >
  // last > none); each test holds two of the three triggers fixed and
  // varies the third.

  it("returns 'running' when the agent is mid-turn", () => {
    const session = makeSession("a", { agent_status: "Running" });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session, makeSession("b"), makeSession("c")],
      isActiveSession: false,
    });
    expect(kind).toBe("running");
  });

  it("returns 'running' even when also active and last (priority order)", () => {
    const session = makeSession("a", { agent_status: "Running" });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: true,
    });
    expect(kind).toBe("running");
  });

  it("returns 'active' when the session is selected and not running", () => {
    const session = makeSession("a");
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session, makeSession("b"), makeSession("c")],
      isActiveSession: true,
    });
    expect(kind).toBe("active");
  });

  it("returns 'last' when this is the only Active session", () => {
    const session = makeSession("a");
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: false,
    });
    expect(kind).toBe("last");
  });

  it("returns 'none' for a non-active, non-last, non-running close", () => {
    const session = makeSession("a");
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session, makeSession("b"), makeSession("c")],
      isActiveSession: false,
    });
    expect(kind).toBe("none");
  });

  it("ignores Archived sessions when counting toward 'last'", () => {
    const session = makeSession("a");
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [
        session,
        makeSession("b", { status: "Archived" }),
        makeSession("c", { status: "Archived" }),
      ],
      isActiveSession: false,
    });
    // Two archived siblings don't count — `a` is still the only Active
    // one, so closing it triggers the 'last' confirm.
    expect(kind).toBe("last");
  });
});

describe("executeNewTab", () => {
  beforeEach(resetStore);

  it("no-ops when no workspace is selected", async () => {
    useAppStore.setState({ selectedWorkspaceId: null });
    const createChatSession = vi.fn();
    executeNewTab({ createChatSession });
    await Promise.resolve();
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it("file context: bumps requestNewFileNonceByWorkspace and shows the right sidebar", () => {
    useAppStore.setState({
      activeFileTabByWorkspace: { [WS]: "src/main.rs" },
      rightSidebarVisible: false,
      rightSidebarTab: "tasks",
    });
    const createChatSession = vi.fn();

    executeNewTab({ createChatSession });

    const post = useAppStore.getState();
    expect(post.requestNewFileNonceByWorkspace[WS]).toBe(1);
    expect(post.rightSidebarVisible).toBe(true);
    expect(post.rightSidebarTab).toBe("files");
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it("file context: leaves the sidebar alone when it's already on Files + visible", () => {
    useAppStore.setState({
      activeFileTabByWorkspace: { [WS]: "README.md" },
      rightSidebarVisible: true,
      rightSidebarTab: "files",
    });
    const toggleRightSidebar = vi.spyOn(useAppStore.getState(), "toggleRightSidebar");
    const setRightSidebarTab = vi.spyOn(useAppStore.getState(), "setRightSidebarTab");

    executeNewTab();

    expect(toggleRightSidebar).not.toHaveBeenCalled();
    expect(setRightSidebarTab).not.toHaveBeenCalled();
    expect(useAppStore.getState().requestNewFileNonceByWorkspace[WS]).toBe(1);
  });

  it("chat context: creates a session via the service and selects it", async () => {
    useAppStore.setState({
      activeFileTabByWorkspace: {},
      sessionsByWorkspace: { [WS]: [makeSession("a")] },
    });
    const created = makeSession("new-1");
    const createChatSession = vi.fn().mockResolvedValue(created);

    executeNewTab({ createChatSession });
    await new Promise((r) => setTimeout(r, 0));

    expect(createChatSession).toHaveBeenCalledWith(WS);
    const post = useAppStore.getState();
    expect(post.sessionsByWorkspace[WS]?.some((s) => s.id === "new-1")).toBe(true);
    expect(post.selectedSessionIdByWorkspaceId[WS]).toBe("new-1");
  });

  it("chat context: drops the result if the workspace switched mid-flight", async () => {
    useAppStore.setState({ activeFileTabByWorkspace: {} });
    const created = makeSession("new-1");
    const createChatSession = vi.fn(async () => {
      // Simulate a workspace switch landing while the create call was
      // in flight — the in-flight session must NOT get added or
      // selected against the old workspace id.
      useAppStore.setState({ selectedWorkspaceId: "workspace-other" });
      return created;
    });

    executeNewTab({ createChatSession });
    await new Promise((r) => setTimeout(r, 0));

    const post = useAppStore.getState();
    expect(post.sessionsByWorkspace[WS]).toBeUndefined();
    expect(post.selectedSessionIdByWorkspaceId[WS]).toBeUndefined();
  });
});

describe("executeCloseTab", () => {
  beforeEach(resetStore);

  it("no-ops when no workspace is selected", () => {
    useAppStore.setState({ selectedWorkspaceId: null });
    const archiveChatSession = vi.fn();
    executeCloseTab({ archiveChatSession });
    expect(archiveChatSession).not.toHaveBeenCalled();
  });

  it("file context: bumps requestCloseFileTabNonceByWorkspace", () => {
    useAppStore.setState({
      activeFileTabByWorkspace: { [WS]: "src/main.rs" },
    });
    const archiveChatSession = vi.fn();

    executeCloseTab({ archiveChatSession });

    expect(useAppStore.getState().requestCloseFileTabNonceByWorkspace[WS]).toBe(1);
    expect(archiveChatSession).not.toHaveBeenCalled();
  });

  it("diff context: closes the active diff tab via the slice action", () => {
    const closeDiffTab = vi.fn();
    useAppStore.setState({
      diffSelectedFile: "Cargo.toml",
      diffSelectedLayer: "unstaged",
      closeDiffTab: closeDiffTab as unknown as ReturnType<
        typeof useAppStore.getState
      >["closeDiffTab"],
    });

    executeCloseTab();

    expect(closeDiffTab).toHaveBeenCalledWith(WS, "Cargo.toml", "unstaged");
  });

  it("chat context: prompts before closing the active session", async () => {
    const session = makeSession("a");
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [session, makeSession("b")] },
      selectedSessionIdByWorkspaceId: { [WS]: "a" },
    });
    const confirm = vi.fn().mockResolvedValue(true);
    const archiveChatSession = vi.fn().mockResolvedValue(null);

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    // Two ticks: one for the confirm await, one for the archive await.
    await new Promise((r) => setTimeout(r, 0));

    // The hotkey path always targets the active session so the
    // confirm fires (kind = "active"). The message wording isn't
    // pinned here — the i18n-aware copy lives in SessionTabs;
    // contextActions uses an English fallback for the Monaco path.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archiveChatSession).toHaveBeenCalledWith("a");
  });

  it("chat context: cancelled confirm leaves state untouched", async () => {
    const session = makeSession("a");
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [session, makeSession("b")] },
      selectedSessionIdByWorkspaceId: { [WS]: "a" },
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const archiveChatSession = vi.fn();

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archiveChatSession).not.toHaveBeenCalled();
    // Session list unchanged — no archive happened.
    expect(useAppStore.getState().sessionsByWorkspace[WS]?.length).toBe(2);
  });

  it("chat context: prompts and archives a Running session", async () => {
    // Regression for the user-reported "Cmd+W kills running sessions
    // without prompting" — previously synchronous `window.confirm()`
    // returned immediately in the Tauri webview so the dialog never
    // surfaced and the archive ran unchecked. The async-confirm
    // contract here is the same shape Tauri's `ask()` produces.
    const session = makeSession("a", { agent_status: "Running" });
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [session] },
      selectedSessionIdByWorkspaceId: { [WS]: "a" },
    });
    const confirm = vi.fn().mockResolvedValue(false);
    const archiveChatSession = vi.fn();

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Confirm fires for a running session and a "no" answer aborts
    // the archive — the running agent is left alive.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archiveChatSession).not.toHaveBeenCalled();
    // The session is still there.
    expect(
      useAppStore.getState().sessionsByWorkspace[WS]?.[0]?.id,
    ).toBe("a");
  });

  it("chat context: archives a running session when the user confirms", async () => {
    const session = makeSession("a", { agent_status: "Running" });
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [session] },
      selectedSessionIdByWorkspaceId: { [WS]: "a" },
    });
    const confirm = vi.fn().mockResolvedValue(true);
    const archiveChatSession = vi.fn().mockResolvedValue(null);

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(archiveChatSession).toHaveBeenCalledWith("a");
  });

  it("chat context: adds + selects the auto-created replacement when archive returns one", async () => {
    const session = makeSession("a");
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [session] },
      selectedSessionIdByWorkspaceId: { [WS]: "a" },
    });
    const replacement = makeSession("auto-1");
    const confirm = vi.fn().mockResolvedValue(true);
    const archiveChatSession = vi.fn().mockResolvedValue(replacement);

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const post = useAppStore.getState();
    expect(post.sessionsByWorkspace[WS]?.some((s) => s.id === "auto-1")).toBe(true);
    expect(post.selectedSessionIdByWorkspaceId[WS]).toBe("auto-1");
  });

  it("file context wins over diff selection", () => {
    // Both an active file tab AND a diff selection exist — the file
    // path takes priority because the file viewer is what's currently
    // visible in the right pane (see AppLayout's render order).
    useAppStore.setState({
      activeFileTabByWorkspace: { [WS]: "src/main.rs" },
      diffSelectedFile: "Cargo.toml",
    });
    const archiveChatSession = vi.fn();

    executeCloseTab({ archiveChatSession });

    expect(useAppStore.getState().requestCloseFileTabNonceByWorkspace[WS]).toBe(1);
  });
});
