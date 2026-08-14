import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import { withoutPromptsForSession } from "./slices/pendingChatPromptsSlice";
import type { ChatSession } from "../types";

function makeSession(id: string): ChatSession {
  return {
    id,
    workspace_id: "ws-1",
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

describe("pendingChatPromptsSlice", () => {
  beforeEach(() => {
    useAppStore.setState({
      pendingChatPrompts: [],
      sessionsByWorkspace: {},
      selectedSessionIdByWorkspaceId: {},
    });
  });

  it("enqueues a prompt against a session and returns its id", () => {
    const id = useAppStore.getState().enqueueChatPrompt("sess-1", "/review");

    expect(useAppStore.getState().pendingChatPrompts).toEqual([
      { id, sessionId: "sess-1", prompt: "/review" },
    ]);
  });

  it("keeps prompts for different sessions independent and ordered", () => {
    const store = useAppStore.getState();
    store.enqueueChatPrompt("sess-1", "first");
    store.enqueueChatPrompt("sess-2", "other");
    store.enqueueChatPrompt("sess-1", "second");

    expect(
      useAppStore
        .getState()
        .pendingChatPrompts.map((p) => [p.sessionId, p.prompt]),
    ).toEqual([
      ["sess-1", "first"],
      ["sess-2", "other"],
      ["sess-1", "second"],
    ]);
  });

  it("completes only the named entry", () => {
    const store = useAppStore.getState();
    const first = store.enqueueChatPrompt("sess-1", "first");
    store.enqueueChatPrompt("sess-1", "second");

    useAppStore.getState().completeChatPrompt(first);

    expect(
      useAppStore.getState().pendingChatPrompts.map((p) => p.prompt),
    ).toEqual(["second"]);
  });

  it("returns the identical state object for an unknown id", () => {
    useAppStore.getState().enqueueChatPrompt("sess-1", "first");
    const before = useAppStore.getState().pendingChatPrompts;

    useAppStore.getState().completeChatPrompt("not-a-real-id");

    // Reference equality matters: a fresh array here would re-render every
    // subscriber (and retrigger the drain effect) on every no-op complete.
    expect(useAppStore.getState().pendingChatPrompts).toBe(before);
  });

  it("drops a session's queued prompts when that session is removed", () => {
    const store = useAppStore.getState();
    store.enqueueChatPrompt("sess-1", "a");
    store.enqueueChatPrompt("sess-2", "b");
    store.enqueueChatPrompt("sess-1", "c");
    useAppStore.setState({
      sessionsByWorkspace: {
        "ws-1": [makeSession("sess-1"), makeSession("sess-2")],
      },
      selectedSessionIdByWorkspaceId: { "ws-1": "sess-1" },
    });

    useAppStore.getState().removeChatSession("sess-1");

    expect(
      useAppStore.getState().pendingChatPrompts.map((p) => p.prompt),
    ).toEqual(["b"]);
  });
});

describe("withoutPromptsForSession", () => {
  it("returns the same array when nothing targets the session", () => {
    const prompts = [{ id: "a", sessionId: "sess-1", prompt: "x" }];
    expect(withoutPromptsForSession(prompts, "sess-2")).toBe(prompts);
  });

  it("filters out every entry for the session", () => {
    const prompts = [
      { id: "a", sessionId: "sess-1", prompt: "x" },
      { id: "b", sessionId: "sess-2", prompt: "y" },
      { id: "c", sessionId: "sess-1", prompt: "z" },
    ];
    expect(withoutPromptsForSession(prompts, "sess-1")).toEqual([prompts[1]]);
  });
});
