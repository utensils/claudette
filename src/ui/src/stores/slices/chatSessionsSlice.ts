import type { StateCreator } from "zustand";
import type { ChatSession } from "../../types";
import type { AppState } from "../useAppStore";

export interface ChatSessionsSlice {
  sessionsByWorkspace: Record<string, ChatSession[]>;
  selectedSessionIdByWorkspaceId: Record<string, string>;
  setSessionsForWorkspace: (wsId: string, sessions: ChatSession[]) => void;
  addChatSession: (session: ChatSession) => void;
  updateChatSession: (
    sessionId: string,
    updates: Partial<ChatSession>,
  ) => void;
  removeChatSession: (sessionId: string) => void;
  selectSession: (workspaceId: string, sessionId: string) => void;
}

export const createChatSessionsSlice: StateCreator<
  AppState,
  [],
  [],
  ChatSessionsSlice
> = (set) => ({
  sessionsByWorkspace: {},
  selectedSessionIdByWorkspaceId: {},
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
      return {
        sessionsByWorkspace: next,
        selectedSessionIdByWorkspaceId: nextSelected,
      };
    }),
  addChatSession: (session) =>
    set((s) => {
      const existing = s.sessionsByWorkspace[session.workspace_id] ?? [];
      if (existing.some((x) => x.id === session.id)) {
        return s;
      }
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [session.workspace_id]: [...existing, session],
        },
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
          next[wsId] = sessions.filter((x) => x.id !== sessionId);
          if (nextSelected[wsId] === sessionId) {
            const firstActive = next[wsId].find(
              (x) => x.status === "Active",
            );
            if (firstActive) {
              nextSelected[wsId] = firstActive.id;
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
});
