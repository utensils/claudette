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
    // turn_count > 0 so the placeholder-skip rule (turn_count===0 → 'none')
    // doesn't pre-empt the 'active' branch we're checking here.
    const session = makeSession("a", { turn_count: 1 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session, makeSession("b"), makeSession("c")],
      isActiveSession: true,
    });
    expect(kind).toBe("active");
  });

  it("returns 'last' when this is the only Active session", () => {
    const session = makeSession("a", { turn_count: 1 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: false,
    });
    expect(kind).toBe("last");
  });

  it("returns 'none' for a non-active, non-last, non-running close", () => {
    const session = makeSession("a", { turn_count: 1 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session, makeSession("b"), makeSession("c")],
      isActiveSession: false,
    });
    expect(kind).toBe("none");
  });

  it("ignores Archived sessions when counting toward 'last'", () => {
    const session = makeSession("a", { turn_count: 1 });
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

  it("returns 'none' for a fresh placeholder regardless of last/active", () => {
    // Pin the new behaviour: turn_count===0 short-circuits the
    // confirm-prompt logic so closing a brand-new "New chat" (the only
    // session in the workspace, currently active) doesn't trip the
    // "active" or "last" prompts. There's nothing to lose, and the user
    // explicitly wants the empty-tabs view to be reachable from there.
    const session = makeSession("a", { turn_count: 0 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: true,
    });
    expect(kind).toBe("none");
  });

  it("preserves the confirm when a fresh placeholder has a draft typed", () => {
    // Regression: a brand-new session with turn_count===0 but unsent
    // composer content must still trip the close confirmation —
    // otherwise Cmd+W silently archives the session AND removeChatSession
    // wipes the draft, discarding the user's in-progress prompt without
    // a warning. The `draft` arg lets the helper see that work-in-flight.
    const session = makeSession("a", { turn_count: 0 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: true,
      draft: "  half-typed prompt ",
    });
    expect(kind).toBe("active");
  });

  it("preserves the confirm when a fresh placeholder has a pending attachment", () => {
    // Same regression as above for attachments: a screenshot dropped onto
    // the composer survives in pendingAttachmentsBySession until the user
    // sends. Dropping the confirm here would silently lose that file.
    const session = makeSession("a", { turn_count: 0 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: true,
      pendingAttachmentsCount: 1,
    });
    expect(kind).toBe("active");
  });

  it("treats whitespace-only drafts as empty (no spurious confirm)", () => {
    // Whitespace-only drafts (newlines from cursor positioning, leftover
    // spaces from a focus-fallthrough) shouldn't trigger the unsent-work
    // confirm — that would feel like a phantom dialog.
    const session = makeSession("a", { turn_count: 0 });
    const kind = chatCloseConfirmKind({
      session,
      activeSessions: [session],
      isActiveSession: true,
      draft: "   \n  ",
    });
    expect(kind).toBe("none");
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
    // turn_count > 0 so the placeholder-skip rule doesn't fire; we want
    // the confirm path here to assert the "active session" branch.
    const session = makeSession("a", { turn_count: 3 });
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
    // Two sessions present, so this isn't the workspace's last tab —
    // the auto-replace flag stays at the historical default of true.
    expect(archiveChatSession).toHaveBeenCalledWith("a", true);
  });

  it("chat context: after Cmd+W closes a session, selects the tab to its left", async () => {
    useAppStore.setState({
      sessionsByWorkspace: {
        [WS]: [makeSession("a"), makeSession("b"), makeSession("c")],
      },
      selectedSessionIdByWorkspaceId: { [WS]: "c" },
    });
    const confirm = vi.fn().mockResolvedValue(true);
    const archiveChatSession = vi.fn().mockResolvedValue(null);

    executeCloseTab({ confirm, archiveChatSession });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const post = useAppStore.getState();
    expect(post.sessionsByWorkspace[WS]?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(post.selectedSessionIdByWorkspaceId[WS]).toBe("b");
  });

  it("chat context: cancelled confirm leaves state untouched", async () => {
    // turn_count > 0 keeps the placeholder-skip rule out of this test —
    // we want to assert that the "no" answer to a real confirm aborts.
    const session = makeSession("a", { turn_count: 3 });
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
    // This is the workspace's last tab (no diff/file tabs either) so
    // the auto-replace flag flips to false — the workspace lands on
    // its empty-tabs view instead of getting a fresh placeholder.
    expect(archiveChatSession).toHaveBeenCalledWith("a", false);
  });

  it("chat context: adds + selects the auto-created replacement when archive returns one", async () => {
    // Two sessions so isLastSession=false, auto-replace flag stays true.
    // The mock returns a replacement to exercise the "promote new session"
    // branch — what we're pinning here is the frontend selection path,
    // not the backend's actual replace decision.
    useAppStore.setState({
      sessionsByWorkspace: { [WS]: [makeSession("a"), makeSession("b")] },
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
