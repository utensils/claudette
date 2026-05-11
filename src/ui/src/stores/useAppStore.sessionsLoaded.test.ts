import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { ChatSession } from "../types";

// `sessionsLoadedByWorkspace` lets ChatPanel distinguish "we just haven't
// fetched yet" from "the workspace genuinely has no sessions" — without it,
// `noOpenTabs` reads true during the lazy `listChatSessions` round-trip and
// the WorkspaceEmptyTabs placard flashes for ~50-150ms on every workspace
// switch / app launch. These tests pin the flag's contract so a future
// refactor of the slice can't silently bring the flicker back.

function makeSession(id: string, workspaceId: string): ChatSession {
  return {
    id,
    workspace_id: workspaceId,
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

beforeEach(() => {
  useAppStore.setState({
    sessionsByWorkspace: {},
    sessionsLoadedByWorkspace: {},
    selectedSessionIdByWorkspaceId: {},
  });
});

describe("sessionsLoadedByWorkspace", () => {
  it("starts empty so consumers can detect 'never fetched'", () => {
    expect(useAppStore.getState().sessionsLoadedByWorkspace).toEqual({});
  });

  it("flips to true the first time setSessionsForWorkspace runs", () => {
    useAppStore
      .getState()
      .setSessionsForWorkspace("ws-1", [makeSession("s-1", "ws-1")]);

    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);
  });

  // The regression we're guarding: a backend response with zero sessions
  // is still a *loaded* state. Treating `[]` as "not loaded" would keep
  // the empty-tabs placard suppressed forever for genuinely empty workspaces.
  it("flips to true even when the backend returns an empty list", () => {
    useAppStore.getState().setSessionsForWorkspace("ws-1", []);

    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);
  });

  it("tracks each workspace independently", () => {
    useAppStore.getState().setSessionsForWorkspace("ws-1", []);
    expect(useAppStore.getState().sessionsLoadedByWorkspace).toEqual({
      "ws-1": true,
    });
    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-2"]).toBeUndefined();

    useAppStore.getState().setSessionsForWorkspace("ws-2", []);
    expect(useAppStore.getState().sessionsLoadedByWorkspace).toEqual({
      "ws-1": true,
      "ws-2": true,
    });
  });

  // Reference stability matters because ChatPanel subscribes to this map
  // via `useAppStore((s) => s.sessionsLoadedByWorkspace[id] === true)` —
  // the subscriber doesn't depend on the *map* identity, but anything
  // reading the whole record (devtools, future selectors) would re-render
  // unnecessarily if the slice cloned the object on every session refresh.
  it("reuses the same record reference on subsequent updates", () => {
    useAppStore.getState().setSessionsForWorkspace("ws-1", []);
    const firstRef = useAppStore.getState().sessionsLoadedByWorkspace;

    useAppStore
      .getState()
      .setSessionsForWorkspace("ws-1", [makeSession("s-1", "ws-1")]);
    const secondRef = useAppStore.getState().sessionsLoadedByWorkspace;

    expect(secondRef).toBe(firstRef);
  });

  it("does not reset when removeChatSession archives the last session", () => {
    useAppStore
      .getState()
      .setSessionsForWorkspace("ws-1", [makeSession("s-1", "ws-1")]);
    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);

    // Removing the last session must not reset the loaded flag — the
    // workspace is still "we asked and now know it's empty". A reset
    // would re-show the loading shell after the user archives their
    // only session, which would feel like a regression.
    useAppStore.getState().removeChatSession("s-1");
    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);
  });

  // addChatSession is the writer for newly-created sessions and for stream
  // events that materialize a session before the initial `listChatSessions`
  // fetch resolves. If it didn't also mark the workspace loaded, ChatPanel
  // would stay on the blank loading shell despite having tabs to render.
  it("flips to true when addChatSession inserts the first session", () => {
    useAppStore.getState().addChatSession(makeSession("s-1", "ws-1"));
    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);
  });

  it("addChatSession reuses the record reference when already loaded", () => {
    useAppStore.getState().setSessionsForWorkspace("ws-1", []);
    const firstRef = useAppStore.getState().sessionsLoadedByWorkspace;

    useAppStore.getState().addChatSession(makeSession("s-1", "ws-1"));
    const secondRef = useAppStore.getState().sessionsLoadedByWorkspace;

    expect(secondRef).toBe(firstRef);
  });

  // markSessionsLoaded is the recovery path for SessionTabs' load-error case:
  // a failed `listChatSessions` would otherwise leave the chat surface on
  // the blank loading shell with no way out. The flag flip lets the user
  // fall through to WorkspaceEmptyTabs and create a session manually.
  describe("markSessionsLoaded", () => {
    it("flips the flag without touching the session list", () => {
      useAppStore.getState().markSessionsLoaded("ws-1");

      const state = useAppStore.getState();
      expect(state.sessionsLoadedByWorkspace["ws-1"]).toBe(true);
      // Critical: existing/racing session data must survive the recovery path.
      expect(state.sessionsByWorkspace["ws-1"]).toBeUndefined();
    });

    it("does not clobber sessions inserted by a racing addChatSession", () => {
      useAppStore.getState().addChatSession(makeSession("s-1", "ws-1"));
      useAppStore.getState().markSessionsLoaded("ws-1");

      const state = useAppStore.getState();
      expect(state.sessionsByWorkspace["ws-1"]).toHaveLength(1);
      expect(state.sessionsByWorkspace["ws-1"][0].id).toBe("s-1");
      expect(state.sessionsLoadedByWorkspace["ws-1"]).toBe(true);
    });

    it("is a no-op when already loaded — preserves record reference", () => {
      useAppStore.getState().setSessionsForWorkspace("ws-1", []);
      const firstRef = useAppStore.getState().sessionsLoadedByWorkspace;

      useAppStore.getState().markSessionsLoaded("ws-1");
      const secondRef = useAppStore.getState().sessionsLoadedByWorkspace;

      expect(secondRef).toBe(firstRef);
    });
  });
});
