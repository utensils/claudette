import type { StateCreator } from "zustand";
import type { AttachmentInput } from "../../types";
import type { AppState } from "../useAppStore";
import { clearSessionAttention } from "./_shared";

export interface AgentQuestionItem {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AgentQuestion {
  sessionId: string;
  toolUseId: string;
  questions: AgentQuestionItem[];
}

export interface PlanApproval {
  sessionId: string;
  toolUseId: string;
  planFilePath: string | null;
  allowedPrompts: Array<{ tool: string; prompt: string }>;
}

/**
 * Per-workspace state for the in-chat Cmd/Ctrl+F search bar.
 * `query` is preserved when the bar is closed so re-opening with the same
 * workspace selected restores the previous search.
 * `matchIndex` is the active match's 0-based index across all hits in the
 * current workspace; -1 when there are no matches yet.
 */
export interface ChatSearchState {
  open: boolean;
  query: string;
  matchIndex: number;
}

export interface QueuedMessage {
  id: string;
  content: string;
  mentionedFiles?: string[];
  attachments?: AttachmentInput[];
}

function createQueuedMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random()}`;
}

export interface AgentInteractionSlice {
  agentQuestions: Record<string, AgentQuestion>;
  setAgentQuestion: (q: AgentQuestion) => void;
  clearAgentQuestion: (sessionId: string) => void;

  planApprovals: Record<string, PlanApproval>;
  setPlanApproval: (p: PlanApproval) => void;
  clearPlanApproval: (sessionId: string) => void;

  chatSearch: Record<string, ChatSearchState>;
  openChatSearch: (wsId: string) => void;
  closeChatSearch: (wsId: string) => void;
  setChatSearchQuery: (wsId: string, query: string) => void;
  setChatSearchMatchIndex: (wsId: string, idx: number) => void;

  queuedMessages: Record<string, QueuedMessage[]>;
  setQueuedMessage: (
    sessionId: string,
    content: string,
    mentionedFiles?: string[],
    attachments?: AttachmentInput[],
  ) => void;
  removeQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  clearQueuedMessage: (sessionId: string) => void;
}

export const createAgentInteractionSlice: StateCreator<
  AppState,
  [],
  [],
  AgentInteractionSlice
> = (set) => ({
  agentQuestions: {},
  setAgentQuestion: (q) =>
    set((s) => ({
      agentQuestions: { ...s.agentQuestions, [q.sessionId]: q },
    })),
  clearAgentQuestion: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.agentQuestions;
      // Also clear the corresponding ChatSession attention flag so the tab
      // icon + sidebar aggregate update immediately, without waiting for a
      // list_chat_sessions refresh.
      const nextSessions = clearSessionAttention(s.sessionsByWorkspace, sessionId);
      return { agentQuestions: rest, sessionsByWorkspace: nextSessions };
    }),

  planApprovals: {},
  setPlanApproval: (p) =>
    set((s) => ({
      planApprovals: { ...s.planApprovals, [p.sessionId]: p },
    })),
  clearPlanApproval: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.planApprovals;
      const nextSessions = clearSessionAttention(s.sessionsByWorkspace, sessionId);
      return { planApprovals: rest, sessionsByWorkspace: nextSessions };
    }),

  chatSearch: {},
  openChatSearch: (wsId) =>
    set((s) => {
      const prev = s.chatSearch[wsId];
      return {
        chatSearch: {
          ...s.chatSearch,
          [wsId]: {
            open: true,
            query: prev?.query ?? "",
            matchIndex: prev?.matchIndex ?? -1,
          },
        },
      };
    }),
  closeChatSearch: (wsId) =>
    set((s) => {
      const prev = s.chatSearch[wsId];
      // Preserve query/matchIndex so re-opening restores the previous search.
      // Return the existing state reference for no-op paths so Zustand's
      // identity check skips the listener notification entirely.
      if (!prev) return s;
      if (!prev.open) return s;
      return {
        chatSearch: {
          ...s.chatSearch,
          [wsId]: { ...prev, open: false },
        },
      };
    }),
  setChatSearchQuery: (wsId, query) =>
    set((s) => {
      const prev = s.chatSearch[wsId] ?? {
        open: true,
        query: "",
        matchIndex: -1,
      };
      // Reset matchIndex on every query change — the new query produces a
      // fresh match set, so any prior index is meaningless.
      return {
        chatSearch: {
          ...s.chatSearch,
          [wsId]: { ...prev, query, matchIndex: -1 },
        },
      };
    }),
  setChatSearchMatchIndex: (wsId, idx) =>
    set((s) => {
      const prev = s.chatSearch[wsId];
      if (!prev) return s;
      if (prev.matchIndex === idx) return s;
      return {
        chatSearch: {
          ...s.chatSearch,
          [wsId]: { ...prev, matchIndex: idx },
        },
      };
    }),

  queuedMessages: {},
  setQueuedMessage: (sessionId, content, mentionedFiles, attachments) =>
    set((s) => ({
      queuedMessages: {
        ...s.queuedMessages,
        [sessionId]: [
          ...(s.queuedMessages[sessionId] || []),
          { id: createQueuedMessageId(), content, mentionedFiles, attachments },
        ],
      },
    })),
  removeQueuedMessage: (sessionId, queuedMessageId) =>
    set((s) => {
      const remaining = (s.queuedMessages[sessionId] || []).filter(
        (message) => message.id !== queuedMessageId,
      );
      if (remaining.length === 0) {
        const { [sessionId]: _, ...rest } = s.queuedMessages;
        return { queuedMessages: rest };
      }
      return {
        queuedMessages: {
          ...s.queuedMessages,
          [sessionId]: remaining,
        },
      };
    }),
  clearQueuedMessage: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.queuedMessages;
      return { queuedMessages: rest };
    }),
});
