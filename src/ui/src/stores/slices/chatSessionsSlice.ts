import type { StateCreator } from "zustand";
import type { ChatSession } from "../../types";
import type { AppState } from "../useAppStore";

export interface ChatSessionsSlice {
  sessionsByWorkspace: Record<string, ChatSession[]>;
  selectedSessionIdByWorkspaceId: Record<string, string>;
  /** Set to `true` once we have a confirmed answer for a given workspace —
   *  either `setSessionsForWorkspace` resolved (the happy path), `addChatSession`
   *  inserted a row before the initial fetch landed (race), or `markSessionsLoaded`
   *  was called explicitly (error recovery). Distinguishes "we just don't know
   *  yet" from "we asked and the list is genuinely empty". Without this,
   *  ChatPanel's `noOpenTabs` empty-state placard flashes for ~50-150ms on every
   *  workspace switch / app launch — sessions are loaded lazily by `SessionTabs`
   *  mounting, but the empty-state branch fires the moment `selectedWorkspaceId`
   *  flips, before that fetch lands. Once set, the flag stays set; a fresh page
   *  hydration is the only thing that can reset it. */
  sessionsLoadedByWorkspace: Record<string, boolean>;
  setSessionsForWorkspace: (wsId: string, sessions: ChatSession[]) => void;
  addChatSession: (session: ChatSession) => void;
  updateChatSession: (
    sessionId: string,
    updates: Partial<ChatSession>,
  ) => void;
  removeChatSession: (sessionId: string) => void;
  selectSession: (workspaceId: string, sessionId: string) => void;
  /** Mark a workspace's sessions as "we have an authoritative answer" without
   *  mutating the session list. Used by `SessionTabs`' load-error path so a
   *  failed initial `listChatSessions` doesn't strand the chat surface on the
   *  blank loading shell forever — the user falls through to `WorkspaceEmptyTabs`
   *  (with its `+ Open new session` affordance) and can recover. */
  markSessionsLoaded: (wsId: string) => void;
}

export const createChatSessionsSlice: StateCreator<
  AppState,
  [],
  [],
  ChatSessionsSlice
> = (set) => ({
  sessionsByWorkspace: {},
  selectedSessionIdByWorkspaceId: {},
  sessionsLoadedByWorkspace: {},
  setSessionsForWorkspace: (wsId, sessions) =>
    set((s) => {
      const next = { ...s.sessionsByWorkspace, [wsId]: sessions };
      const nextSelected = { ...s.selectedSessionIdByWorkspaceId };
      const selected = nextSelected[wsId];
      const activeSessions = sessions.filter((x) => x.status === "Active");
      const selectedIsActive =
        selected && activeSessions.some((x) => x.id === selected);
      if (!selectedIsActive && activeSessions.length > 0) {
        nextSelected[wsId] = activeSessions[0].id;
      }
      // Reuse the existing record when the flag was already set, so callers
      // subscribing only to `sessionsLoadedByWorkspace` don't re-render on
      // every session-list refresh — only on the first transition.
      const sessionsLoadedByWorkspace = s.sessionsLoadedByWorkspace[wsId]
        ? s.sessionsLoadedByWorkspace
        : { ...s.sessionsLoadedByWorkspace, [wsId]: true };
      return {
        sessionsByWorkspace: next,
        selectedSessionIdByWorkspaceId: nextSelected,
        sessionsLoadedByWorkspace,
      };
    }),
  addChatSession: (session) =>
    set((s) => {
      const existing = s.sessionsByWorkspace[session.workspace_id] ?? [];
      if (existing.some((x) => x.id === session.id)) {
        return s;
      }
      // A workspace with at least one session is, by definition, "loaded" —
      // we have authoritative state to render. Marking the flag here closes
      // the race where the user creates (or the backend pushes) a new session
      // before the initial `listChatSessions` fetch resolves, which would
      // otherwise leave ChatPanel stuck on the blank loading shell despite
      // the session being available.
      const sessionsLoadedByWorkspace = s.sessionsLoadedByWorkspace[session.workspace_id]
        ? s.sessionsLoadedByWorkspace
        : { ...s.sessionsLoadedByWorkspace, [session.workspace_id]: true };
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [session.workspace_id]: [...existing, session],
        },
        sessionsLoadedByWorkspace,
      };
    }),
  updateChatSession: (sessionId, updates) =>
    set((s) => {
      for (const [wsId, sessions] of Object.entries(s.sessionsByWorkspace)) {
        const idx = sessions.findIndex((x) => x.id === sessionId);
        if (idx >= 0) {
          const updated = [...sessions];
          updated[idx] = { ...updated[idx], ...updates };
          return {
            sessionsByWorkspace: {
              ...s.sessionsByWorkspace,
              [wsId]: updated,
            },
          };
        }
      }
      return s;
    }),
  removeChatSession: (sessionId) =>
    set((s) => {
      const next = { ...s.sessionsByWorkspace };
      const nextSelected = { ...s.selectedSessionIdByWorkspaceId };
      for (const [wsId, sessions] of Object.entries(next)) {
        if (sessions.some((x) => x.id === sessionId)) {
          const activeSessions = sessions.filter((x) => x.status === "Active");
          const activeIdx = activeSessions.findIndex((x) => x.id === sessionId);
          next[wsId] = sessions.filter((x) => x.id !== sessionId);
          if (nextSelected[wsId] === sessionId) {
            const adjacentActive =
              activeIdx > 0
                ? activeSessions[activeIdx - 1]
                : activeIdx === 0
                  ? activeSessions[1]
                  : next[wsId].find((x) => x.status === "Active");
            if (adjacentActive) {
              nextSelected[wsId] = adjacentActive.id;
            } else {
              delete nextSelected[wsId];
            }
          }
          break;
        }
      }
      const nextDrafts = { ...s.chatDrafts };
      delete nextDrafts[sessionId];
      const nextAttachments = { ...s.pendingAttachmentsBySession };
      delete nextAttachments[sessionId];
      return {
        sessionsByWorkspace: next,
        selectedSessionIdByWorkspaceId: nextSelected,
        chatDrafts: nextDrafts,
        pendingAttachmentsBySession: nextAttachments,
      };
    }),
  selectSession: (workspaceId, sessionId) =>
    set((s) => ({
      selectedSessionIdByWorkspaceId: {
        ...s.selectedSessionIdByWorkspaceId,
        [workspaceId]: sessionId,
      },
      // Clicking a chat tab is an explicit "show me chat" intent, so any
      // active diff view yields. Diff tabs themselves remain in the strip.
      diffSelectedFile: null,
      diffSelectedLayer: null,
      diffPreviewMode: "diff",
      diffPreviewContent: null,
      diffPreviewLoading: false,
      diffPreviewError: null,
    })),
  markSessionsLoaded: (wsId) =>
    set((s) => {
      if (s.sessionsLoadedByWorkspace[wsId]) return s;
      return {
        sessionsLoadedByWorkspace: {
          ...s.sessionsLoadedByWorkspace,
          [wsId]: true,
        },
      };
    }),
});
