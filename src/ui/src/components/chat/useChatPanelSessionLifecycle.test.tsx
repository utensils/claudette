// @vitest-environment happy-dom

// Behavior pins for `useChatPanelSessionLifecycle`: initial history load for
// the active session, older-message pagination on scroll-to-top, and
// per-session scroll memory. Exercised through the composed hook so the
// suite also covers the wiring between the focused sub-hooks.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import type {
  ChatHistoryPage,
  ChatMessage,
  ChatSession,
  Workspace,
} from "../../types";
import { useChatPanelSessionLifecycle } from "./useChatPanelSessionLifecycle";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const serviceMocks = vi.hoisted(() => ({
  getAppSetting: vi.fn((_key: string) => Promise.resolve<string | null>(null)),
  listCheckpoints: vi.fn((_sessionId: string) => Promise.resolve([])),
  loadAgentConclusionsForSession: vi.fn((_sessionId: string) =>
    Promise.resolve([]),
  ),
  loadChatHistoryPage: vi.fn(
    (
      _sessionId: string,
      _limit: number,
      _before?: string,
    ): Promise<ChatHistoryPage> =>
      Promise.resolve({
        messages: [],
        attachments: [],
        has_more: false,
        total_count: 0,
      }),
  ),
  loadCompletedTurns: vi.fn((_sessionId: string) => Promise.resolve([])),
  resolveStaleWorkflowActivities: vi.fn((_sessionId: string) =>
    Promise.resolve(0),
  ),
  sendRemoteCommand: vi.fn(
    (_connId: string, _cmd: string, _args: unknown): Promise<unknown> =>
      Promise.resolve([]),
  ),
}));

vi.mock("../../services/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tauri")>();
  return { ...actual, ...serviceMocks };
});

const stickyMocks = vi.hoisted(() => ({
  scrollToBottom: vi.fn(),
  restoreScrollPosition: vi.fn(),
  handleContentChanged: vi.fn(),
  markUserScrollIntent: vi.fn(),
}));

vi.mock("../../hooks/useStickyScroll", () => ({
  useStickyScroll: () => ({
    isAtBottom: true,
    ...stickyMocks,
    suppressNextAutoScrollRef: { current: false },
  }),
}));

vi.mock("../../hooks/usePreventScrollBounce", () => ({
  usePreventScrollBounce: vi.fn(),
}));

const WORKSPACE_ID = "ws-1";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

function makeWorkspace(remoteConnectionId: string | null = null): Workspace {
  return {
    id: WORKSPACE_ID,
    repository_id: "repo-1",
    name: "Workspace",
    worktree_path: "/repo",
    branch_name: "main",
    status: "Active",
    status_line: "",
    created_at: "2026-05-20T00:00:00.000Z",
    sort_order: 0,
    remote_connection_id: remoteConnectionId,
    agent_status: "Idle",
    input_values: null,
  };
}

function makeSession(id: string): ChatSession {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "2026-05-20T00:00:00.000Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

function makeMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  sessionId = SESSION_A,
): ChatMessage {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    chat_session_id: sessionId,
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "2026-05-20T00:00:00.000Z",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending promise chains and rAF callbacks settle. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

type LifecycleResult = ReturnType<typeof useChatPanelSessionLifecycle>;

interface Harness {
  scrollEl: HTMLDivElement;
  historyRef: { current: Record<string, string[]> };
  restoringRef: { current: Set<string> };
  result: () => LifecycleResult;
  setSession: (id: string) => Promise<void>;
}

const mounted: { root: Root; el: HTMLElement }[] = [];
const extraElements: HTMLElement[] = [];

async function mountHarness(sessionId: string): Promise<Harness> {
  const scrollEl = document.createElement("div");
  document.body.appendChild(scrollEl);
  extraElements.push(scrollEl);
  const messagesContainerRef = { current: scrollEl };
  const historyRef = { current: {} as Record<string, string[]> };
  const restoringRef = { current: new Set<string>() };
  const draftRef = { current: "draft" };
  const historyIndexRef = { current: 3 };
  const setError = vi.fn();
  let latest: LifecycleResult | null = null;

  function Probe({ sid }: { sid: string }) {
    const pagination = useAppStore((s) => s.chatPagination[sid]);
    const messages = useAppStore((s) => s.chatMessages[sid]) ?? [];
    const store = useAppStore.getState();
    latest = useChatPanelSessionLifecycle({
      activeSessionId: sid,
      activeSessionIdsKey: [SESSION_A, SESSION_B].join("\0"),
      activitiesCount: 0,
      completedTurnsCount: 0,
      draftRef,
      hasMore: pagination?.hasMore ?? false,
      hasStreaming: false,
      historyIndexRef,
      historyRef,
      hydrateCompletedTurns: store.hydrateCompletedTurns,
      isLoadingMore: pagination?.isLoadingMore ?? false,
      isRunning: false,
      messages,
      messagesContainerRef,
      oldestMessageId: pagination?.oldestMessageId ?? null,
      pendingApproval: null,
      pendingPlan: null,
      pendingQuestion: null,
      restoringChatScrollSessionsRef: restoringRef,
      selectedWorkspaceId: WORKSPACE_ID,
      setChatMessages: store.setChatMessages,
      setChatPagination: store.setChatPagination,
      setError,
      setPermissionLevel: store.setPermissionLevel,
    });
    return null;
  }

  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => {
    root.render(<Probe sid={sessionId} />);
  });
  return {
    scrollEl,
    historyRef,
    restoringRef,
    result: () => latest!,
    setSession: async (id) => {
      act(() => {
        useAppStore.setState({
          selectedSessionIdByWorkspaceId: { [WORKSPACE_ID]: id },
        });
      });
      await act(async () => {
        root.render(<Probe sid={id} />);
      });
    },
  };
}

function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  for (const fn of Object.values(serviceMocks)) fn.mockClear();
  for (const fn of Object.values(stickyMocks)) fn.mockClear();
  serviceMocks.loadChatHistoryPage.mockImplementation(() =>
    Promise.resolve({
      messages: [],
      attachments: [],
      has_more: false,
      total_count: 0,
    }),
  );
  serviceMocks.loadCompletedTurns.mockImplementation(() => Promise.resolve([]));
  useAppStore.setState({
    workspaces: [makeWorkspace()],
    selectedWorkspaceId: WORKSPACE_ID,
    sessionsByWorkspace: {
      [WORKSPACE_ID]: [makeSession(SESSION_A), makeSession(SESSION_B)],
    },
    selectedSessionIdByWorkspaceId: { [WORKSPACE_ID]: SESSION_A },
    chatMessages: {},
    chatAttachments: {},
    chatPagination: {},
    completedTurns: {},
    claudetteMcpEnabled: false,
  });
});

afterEach(async () => {
  for (const { root, el } of mounted.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
    el.remove();
  }
  for (const el of extraElements.splice(0)) el.remove();
});

describe("useChatPanelSessionLifecycle — history load", () => {
  it("loads the first page for the active session and populates the store", async () => {
    serviceMocks.loadChatHistoryPage.mockImplementation(() =>
      Promise.resolve({
        messages: [
          makeMessage("m1", "User", "first prompt"),
          makeMessage("m2", "Assistant", "answer"),
          makeMessage("m3", "User", "second prompt"),
        ],
        attachments: [],
        has_more: true,
        total_count: 120,
      }),
    );

    const h = await mountHarness(SESSION_A);
    await flush();

    expect(serviceMocks.loadChatHistoryPage).toHaveBeenCalledWith(SESSION_A, 50);
    expect(serviceMocks.listCheckpoints).toHaveBeenCalledWith(SESSION_A);
    expect(serviceMocks.getAppSetting).toHaveBeenCalledWith(
      `permission_level:${SESSION_A}`,
    );
    const state = useAppStore.getState();
    expect(state.chatMessages[SESSION_A].map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(state.chatPagination[SESSION_A]).toEqual({
      hasMore: true,
      isLoadingMore: false,
      totalCount: 120,
      oldestMessageId: "m1",
    });
    expect(h.historyRef.current[SESSION_A]).toEqual([
      "first prompt",
      "second prompt",
    ]);
    // Idle local session → completed turns are hydrated after the sweep.
    expect(serviceMocks.resolveStaleWorkflowActivities).toHaveBeenCalledWith(
      SESSION_A,
    );
    expect(serviceMocks.loadCompletedTurns).toHaveBeenCalledWith(SESSION_A);
  });

  it("skips the page fetch when pagination for the session is already loaded", async () => {
    useAppStore.setState({
      chatPagination: {
        [SESSION_A]: {
          hasMore: false,
          isLoadingMore: false,
          totalCount: 1,
          oldestMessageId: "m1",
        },
      },
    });

    await mountHarness(SESSION_A);
    await flush();

    expect(serviceMocks.loadChatHistoryPage).not.toHaveBeenCalled();
    // Checkpoints still refresh for local sessions.
    expect(serviceMocks.listCheckpoints).toHaveBeenCalledWith(SESSION_A);
  });

  it("loads remote history via sendRemoteCommand and drops empty assistant rows", async () => {
    useAppStore.setState({ workspaces: [makeWorkspace("conn-1")] });
    serviceMocks.sendRemoteCommand.mockImplementation(() =>
      Promise.resolve({
        messages: [
          makeMessage("r1", "User", "hi"),
          makeMessage("r2", "Assistant", "   "),
          makeMessage("r3", "Assistant", "hello"),
        ],
      }),
    );

    await mountHarness(SESSION_A);
    await flush();

    expect(serviceMocks.sendRemoteCommand).toHaveBeenCalledWith(
      "conn-1",
      "load_chat_history",
      { chat_session_id: SESSION_A },
    );
    expect(serviceMocks.loadChatHistoryPage).not.toHaveBeenCalled();
    expect(serviceMocks.listCheckpoints).not.toHaveBeenCalled();
    expect(
      useAppStore.getState().chatMessages[SESSION_A].map((m) => m.id),
    ).toEqual(["r1", "r3"]);
  });

  it("ignores a history response that lands after the session changed", async () => {
    const pending = deferred<ChatHistoryPage>();
    serviceMocks.loadChatHistoryPage.mockImplementationOnce(
      () => pending.promise,
    );

    const h = await mountHarness(SESSION_A);
    await h.setSession(SESSION_B);
    await act(async () => {
      pending.resolve({
        messages: [makeMessage("late", "User", "late")],
        attachments: [],
        has_more: false,
        total_count: 1,
      });
    });
    await flush();

    expect(useAppStore.getState().chatMessages[SESSION_A]).toBeUndefined();
  });
});

describe("useChatPanelSessionLifecycle — older-message pagination", () => {
  function seedLoadedSession() {
    useAppStore.setState({
      chatMessages: {
        [SESSION_A]: [
          makeMessage("m10", "User", "newer prompt"),
          makeMessage("m11", "Assistant", "newer answer"),
        ],
      },
      chatPagination: {
        [SESSION_A]: {
          hasMore: true,
          isLoadingMore: false,
          totalCount: 4,
          oldestMessageId: "m10",
        },
      },
    });
  }

  it("prepends older messages when scrolled near the top and hasMore", async () => {
    seedLoadedSession();
    serviceMocks.loadChatHistoryPage.mockImplementation(() =>
      Promise.resolve({
        messages: [
          makeMessage("m8", "User", "older prompt"),
          makeMessage("m9", "Assistant", "older answer"),
        ],
        attachments: [],
        has_more: false,
        total_count: 4,
      }),
    );

    const h = await mountHarness(SESSION_A);
    h.historyRef.current[SESSION_A] = ["newer prompt"];
    await act(async () => {
      scrollTo(h.scrollEl, 50);
    });
    await flush();

    expect(serviceMocks.loadChatHistoryPage).toHaveBeenCalledWith(
      SESSION_A,
      50,
      "m10",
    );
    const state = useAppStore.getState();
    expect(state.chatMessages[SESSION_A].map((m) => m.id)).toEqual([
      "m8",
      "m9",
      "m10",
      "m11",
    ]);
    expect(state.chatPagination[SESSION_A]).toEqual({
      hasMore: false,
      isLoadingMore: false,
      totalCount: 4,
      oldestMessageId: "m8",
    });
    expect(h.historyRef.current[SESSION_A]).toEqual([
      "older prompt",
      "newer prompt",
    ]);
    expect(serviceMocks.loadCompletedTurns).toHaveBeenCalledWith(SESSION_A);
  });

  it("does not double-fetch while a page is already loading", async () => {
    seedLoadedSession();
    const pending = deferred<ChatHistoryPage>();
    serviceMocks.loadChatHistoryPage.mockImplementation(() => pending.promise);

    const h = await mountHarness(SESSION_A);
    await act(async () => {
      scrollTo(h.scrollEl, 50);
      scrollTo(h.scrollEl, 40);
    });
    expect(useAppStore.getState().chatPagination[SESSION_A].isLoadingMore).toBe(
      true,
    );
    await act(async () => {
      scrollTo(h.scrollEl, 30);
    });

    expect(serviceMocks.loadChatHistoryPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({
        messages: [makeMessage("m9", "User", "older")],
        attachments: [],
        has_more: true,
        total_count: 5,
      });
    });
    await flush();
    expect(useAppStore.getState().chatPagination[SESSION_A].isLoadingMore).toBe(
      false,
    );
  });

  it("does not fetch when scrolled below the threshold or hasMore is false", async () => {
    seedLoadedSession();
    const h = await mountHarness(SESSION_A);
    await act(async () => {
      scrollTo(h.scrollEl, 250);
    });
    expect(serviceMocks.loadChatHistoryPage).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.setState({
        chatPagination: {
          [SESSION_A]: {
            hasMore: false,
            isLoadingMore: false,
            totalCount: 2,
            oldestMessageId: "m10",
          },
        },
      });
    });
    await act(async () => {
      scrollTo(h.scrollEl, 10);
    });
    expect(serviceMocks.loadChatHistoryPage).not.toHaveBeenCalled();
  });

  it("clears isLoadingMore when the older-page fetch fails", async () => {
    seedLoadedSession();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    serviceMocks.loadChatHistoryPage.mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );

    const h = await mountHarness(SESSION_A);
    await act(async () => {
      scrollTo(h.scrollEl, 10);
    });
    await flush();

    const pagination = useAppStore.getState().chatPagination[SESSION_A];
    expect(pagination.isLoadingMore).toBe(false);
    expect(pagination.oldestMessageId).toBe("m10");
    expect(useAppStore.getState().chatMessages[SESSION_A]).toHaveLength(2);
    errSpy.mockRestore();
  });
});

describe("useChatPanelSessionLifecycle — scroll memory", () => {
  it("scrolls to bottom for a session with no remembered position", async () => {
    await mountHarness(SESSION_A);
    expect(stickyMocks.scrollToBottom).toHaveBeenCalled();
    expect(stickyMocks.restoreScrollPosition).not.toHaveBeenCalled();
  });

  it("restores the remembered scroll position when switching back", async () => {
    const h = await mountHarness(SESSION_A);
    await act(async () => {
      scrollTo(h.scrollEl, 300);
    });

    await h.setSession(SESSION_B);
    await flush();
    stickyMocks.restoreScrollPosition.mockClear();

    await h.setSession(SESSION_A);
    await flush();

    expect(stickyMocks.restoreScrollPosition).toHaveBeenCalledWith(300);
    // The restore loop finishes and releases the handshake set.
    expect(h.restoringRef.current.has(SESSION_A)).toBe(false);
  });

  it("rememberChatScrollPosition records the position and marks the session restoring", async () => {
    const h = await mountHarness(SESSION_A);
    h.scrollEl.scrollTop = 175;
    act(() => {
      h.result().rememberChatScrollPosition();
    });
    expect(h.restoringRef.current.has(SESSION_A)).toBe(true);

    await h.setSession(SESSION_B);
    await flush();
    stickyMocks.restoreScrollPosition.mockClear();
    await h.setSession(SESSION_A);
    await flush();

    expect(stickyMocks.restoreScrollPosition).toHaveBeenCalledWith(175);
  });
});
