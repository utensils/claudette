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

export type AgentApprovalKind = "commandExecution" | "fileChange" | "permissions";

export interface AgentApprovalDetail {
  labelKey: "command" | "cwd" | "path" | "permissions" | "reason";
  value: string;
}

export interface AgentApproval {
  sessionId: string;
  toolUseId: string;
  kind: AgentApprovalKind;
  details: AgentApprovalDetail[];
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

let queuedMessageFallbackCounter = 0;

function createQueuedMessageId(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto?.getRandomValues) {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return `queued-${Array.from(values, (value) => value.toString(36)).join("-")}`;
  }
  queuedMessageFallbackCounter += 1;
  return `queued-${Date.now()}-${queuedMessageFallbackCounter}`;
}

function syncSessionAttention(
  state: AppState,
  sessionId: string,
  nextSources: {
    agentQuestions?: Record<string, AgentQuestion>;
    planApprovals?: Record<string, PlanApproval>;
    agentApprovals?: Record<string, AgentApproval>;
  },
) {
  const agentQuestions = nextSources.agentQuestions ?? state.agentQuestions;
  const planApprovals = nextSources.planApprovals ?? state.planApprovals;
  const agentApprovals = nextSources.agentApprovals ?? state.agentApprovals;
  const hasPlan = Boolean(planApprovals[sessionId]);
  const hasAsk = Boolean(agentQuestions[sessionId] || agentApprovals[sessionId]);
  if (!hasPlan && !hasAsk) {
    return clearSessionAttention(state.sessionsByWorkspace, sessionId);
  }
  for (const [wsId, sessions] of Object.entries(state.sessionsByWorkspace)) {
    const idx = sessions.findIndex((session) => session.id === sessionId);
    if (idx >= 0) {
      const updated = [...sessions];
      updated[idx] = {
        ...updated[idx],
        needs_attention: true,
        attention_kind: hasPlan ? "Plan" : "Ask",
      };
      return { ...state.sessionsByWorkspace, [wsId]: updated };
    }
  }
  return state.sessionsByWorkspace;
}

export interface AgentInteractionSlice {
  agentQuestions: Record<string, AgentQuestion>;
  setAgentQuestion: (q: AgentQuestion) => void;
  clearAgentQuestion: (sessionId: string) => void;

  planApprovals: Record<string, PlanApproval>;
  setPlanApproval: (p: PlanApproval) => void;
  clearPlanApproval: (sessionId: string) => void;

  agentApprovals: Record<string, AgentApproval>;
  setAgentApproval: (approval: AgentApproval) => void;
  clearAgentApproval: (sessionId: string) => void;

  chatSearch: Record<string, ChatSearchState>;
  openChatSearch: (wsId: string) => void;
  closeChatSearch: (wsId: string) => void;
  setChatSearchQuery: (wsId: string, query: string) => void;
  setChatSearchMatchIndex: (wsId: string, idx: number) => void;

  queuedMessages: Record<string, QueuedMessage[]>;
  queuedMessageAutoDispatchPaused: Record<string, boolean>;
  setQueuedMessage: (
    sessionId: string,
    content: string,
    mentionedFiles?: string[],
    attachments?: AttachmentInput[],
  ) => void;
  updateQueuedMessage: (
    sessionId: string,
    queuedMessageId: string,
    updates: { content: string; mentionedFiles?: string[] | undefined },
  ) => void;
  removeQueuedMessage: (sessionId: string, queuedMessageId: string) => void;
  clearQueuedMessage: (sessionId: string) => void;
  setQueuedMessageAutoDispatchPaused: (sessionId: string, paused: boolean) => void;
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
      const nextSessions = syncSessionAttention(s, sessionId, {
        agentQuestions: rest,
      });
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
      const nextSessions = syncSessionAttention(s, sessionId, {
        planApprovals: rest,
      });
      return { planApprovals: rest, sessionsByWorkspace: nextSessions };
    }),

  agentApprovals: {},
  setAgentApproval: (approval) =>
    set((s) => ({
      agentApprovals: { ...s.agentApprovals, [approval.sessionId]: approval },
    })),
  clearAgentApproval: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.agentApprovals;
      const nextSessions = syncSessionAttention(s, sessionId, {
        agentApprovals: rest,
      });
      return { agentApprovals: rest, sessionsByWorkspace: nextSessions };
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
  queuedMessageAutoDispatchPaused: {},
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
  updateQueuedMessage: (sessionId, queuedMessageId, updates) =>
    set((s) => {
      const messages = s.queuedMessages[sessionId];
      if (!messages) return s;

      let didUpdate = false;
      const nextMessages = messages.map((message) => {
        if (message.id !== queuedMessageId) return message;
        didUpdate = true;
        if (!Object.prototype.hasOwnProperty.call(updates, "mentionedFiles")) {
          return { ...message, content: updates.content };
        }
        const { mentionedFiles: _, ...messageWithoutMentionedFiles } = message;
        return updates.mentionedFiles
          ? { ...messageWithoutMentionedFiles, ...updates }
          : { ...messageWithoutMentionedFiles, content: updates.content };
      });
      if (!didUpdate) return s;

      return {
        queuedMessages: {
          ...s.queuedMessages,
          [sessionId]: nextMessages,
        },
      };
    }),
  removeQueuedMessage: (sessionId, queuedMessageId) =>
    set((s) => {
      const remaining = (s.queuedMessages[sessionId] || []).filter(
        (message) => message.id !== queuedMessageId,
      );
      if (remaining.length === 0) {
        const { [sessionId]: _, ...rest } = s.queuedMessages;
        const {
          [sessionId]: _paused,
          ...pausedRest
        } = s.queuedMessageAutoDispatchPaused;
        return {
          queuedMessages: rest,
          queuedMessageAutoDispatchPaused: pausedRest,
        };
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
      const {
        [sessionId]: _paused,
        ...pausedRest
      } = s.queuedMessageAutoDispatchPaused;
      return {
        queuedMessages: rest,
        queuedMessageAutoDispatchPaused: pausedRest,
      };
    }),
  setQueuedMessageAutoDispatchPaused: (sessionId, paused) =>
    set((s) => {
      const current = s.queuedMessageAutoDispatchPaused[sessionId] === true;
      if (current === paused) return s;
      if (!paused) {
        const {
          [sessionId]: _,
          ...rest
        } = s.queuedMessageAutoDispatchPaused;
        return { queuedMessageAutoDispatchPaused: rest };
      }
      return {
        queuedMessageAutoDispatchPaused: {
          ...s.queuedMessageAutoDispatchPaused,
          [sessionId]: true,
        },
      };
    }),
});
