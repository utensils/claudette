import type { StateCreator } from "zustand";
import type { ChatMessage, ChatAttachment, ChatPaginationState } from "../../types";
import type { StoredAttachment } from "../../types/chat";
import { debugChat } from "../../utils/chatDebug";
import type { CompactionEvent } from "../../utils/compactionSentinel";
import type { AppState } from "../useAppStore";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  inputJson: string;
  resultText: string;
  collapsed: boolean;
  summary: string;
  startedAt?: string;
  assistantMessageOrdinal?: number;
  agentTaskId?: string | null;
  agentDescription?: string | null;
  agentLastToolName?: string | null;
  agentToolUseCount?: number | null;
  agentStatus?: string | null;
  agentToolCalls?: AgentToolCall[];
}

export interface AgentToolCall {
  toolUseId: string;
  toolName: string;
  agentId: string;
  agentType?: string | null;
  input?: unknown;
  response?: unknown;
  error?: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string | null;
}

export interface CompletedTurn {
  id: string;
  activities: ToolActivity[];
  messageCount: number;
  collapsed: boolean;
  /** Index into chatMessages at the time of finalization — used to render
   *  the turn summary at the correct chronological position. */
  afterMessageIndex: number;
  /** Commit hash from the corresponding conversation checkpoint, if any.
   *  Used to gate the "fork workspace at this turn" action. */
  commitHash?: string | null;
  /** Total time this turn took, in milliseconds. Summed from the
   *  duration_ms of assistant messages produced during the turn. */
  durationMs?: number;
  /** Turn-total input tokens. Live turns receive this from the CLI's
   *  `result.usage`; persisted turns are reconstructed by summing the
   *  `input_tokens` of each assistant `ChatMessage` in the turn (see
   *  `reconstructCompletedTurns`). Undefined for legacy turns with no
   *  token metadata on any message. */
  inputTokens?: number;
  /** Turn-total output tokens. Live turns receive this from the CLI's
   *  `result.usage`; persisted turns are reconstructed by summing the
   *  `output_tokens` of each assistant `ChatMessage` in the turn. */
  outputTokens?: number;
  /** Turn-total cache-read tokens. Live turns receive this from the CLI's
   *  `result.usage.cache_read_input_tokens`. Persisted turns use the MAX
   *  (not sum) of per-message `cache_read_tokens` — cache counts are
   *  cumulative-per-API-call, so summing across a multi-message tool-use
   *  turn would double-count the shared prompt prefix each call re-reads. */
  cacheReadTokens?: number;
  /** Turn-total cache-creation tokens. Same max-based reconstruction semantics
   *  as `cacheReadTokens`. */
  cacheCreationTokens?: number;
}

/**
 * Token usage from the most recent completed turn for a chat session.
 * Lives as its own slice (`latestTurnUsage`) rather than being derived from
 * `completedTurns` because `finalizeTurn` early-returns for tool-free turns
 * — so a Q&A turn without tool calls doesn't add a CompletedTurn but should
 * still refresh the ContextMeter for that session. The shape matches the
 * `result.usage` block the CLI emits on every turn end.
 */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface ChatSlice {
  chatMessages: Record<string, ChatMessage[]>;
  chatAttachments: Record<string, ChatAttachment[]>;
  setChatAttachments: (sessionId: string, attachments: ChatAttachment[]) => void;
  addChatAttachments: (sessionId: string, attachments: ChatAttachment[]) => void;
  streamingContent: Record<string, string>;
  streamingThinking: Record<string, string>;
  pendingTypewriter: Record<string, { messageId: string; text: string } | null>;
  showThinkingBlocks: Record<string, boolean>;
  toolActivities: Record<string, ToolActivity[]>;
  completedTurns: Record<string, CompletedTurn[]>;
  /** Latest `result.usage` values per chat session — kept in sync with every
   *  turn end, including tool-free turns that don't produce a CompletedTurn.
   *  The ContextMeter reads from here so it reflects the latest turn even
   *  when the timeline doesn't record one. */
  latestTurnUsage: Record<string, TurnUsage>;
  setLatestTurnUsage: (sessionId: string, usage: TurnUsage) => void;
  /** Delete the meter's usage entry for a chat session. Used when a
   *  rollback or empty load leaves no assistant message with token data —
   *  clearing hides the meter rather than leaving a stale value. */
  clearLatestTurnUsage: (sessionId: string) => void;
  // promptStartTime is keyed by workspace id (driven by ChatPanel's
  // `selectedWorkspaceId` and useAgentStream's `wsId`), not session id —
  // the meter spans the whole workspace's active turn.
  promptStartTime: Record<string, number>;
  setPromptStartTime: (wsId: string, time: number) => void;
  clearPromptStartTime: (wsId: string) => void;
  /** Per-session compaction history, re-derived from the persisted
   *  COMPACTION:* sentinel messages on workspace load and updated live
   *  on compact_boundary events. This slice stores derived metadata
   *  for future consumers (e.g. a compaction counter); ChatPanel's
   *  divider rendering dispatches on persisted sentinel System messages
   *  in `chatMessages[sessionId]` rather than reading this slice directly. */
  compactionEvents: Record<string, CompactionEvent[]>;
  setCompactionEvents: (sessionId: string, events: CompactionEvent[]) => void;
  addCompactionEvent: (sessionId: string, event: CompactionEvent) => void;
  chatPagination: Record<string, ChatPaginationState>;
  setChatPagination: (sessionId: string, state: ChatPaginationState) => void;
  prependChatMessages: (sessionId: string, messages: ChatMessage[]) => void;
  prependChatAttachments: (sessionId: string, attachments: ChatAttachment[]) => void;
  setChatMessages: (sessionId: string, messages: ChatMessage[]) => void;
  /**
   * Append a chat message to the session's list.
   *
   * Pass `{ persisted: false }` for client-only messages that have no
   * matching DB row (e.g. the System messages produced by local slash
   * commands like `/help`, `/plan`, `/status`). Persisted messages bump
   * `chatPagination[sessionId].totalCount` so `globalOffset` stays correct
   * during streaming; client-only ones must NOT, or the next paginated
   * load returns a smaller total than the in-memory list and turn
   * placement drifts.
   */
  addChatMessage: (
    sessionId: string,
    message: ChatMessage,
    options?: { persisted?: boolean },
  ) => void;
  setStreamingContent: (sessionId: string, content: string) => void;
  appendStreamingContent: (sessionId: string, text: string) => void;
  setPendingTypewriter: (sessionId: string, messageId: string, text: string) => void;
  /** Atomic drain-end handoff: clears both `pendingTypewriter` and
   *  `streamingThinking` in a single store update so the streaming thinking
   *  block and the draining assistant text hand off to the completed message
   *  in the same render, without a gap or a 1-frame duplicate. */
  finishTypewriterDrain: (sessionId: string) => void;
  appendStreamingThinking: (sessionId: string, text: string) => void;
  clearStreamingThinking: (sessionId: string) => void;
  setShowThinkingBlocks: (sessionId: string, show: boolean) => void;
  setToolActivities: (sessionId: string, activities: ToolActivity[]) => void;
  addToolActivity: (sessionId: string, activity: ToolActivity) => void;
  updateToolActivity: (
    sessionId: string,
    toolUseId: string,
    updates: Partial<ToolActivity>,
  ) => void;
  upsertAgentToolCall: (
    sessionId: string,
    agentId: string,
    call: AgentToolCall,
  ) => boolean;
  toggleToolActivityCollapsed: (sessionId: string, index: number) => void;
  finalizeTurn: (
    sessionId: string,
    messageCount: number,
    turnId?: string,
    durationMs?: number,
    inputTokens?: number,
    outputTokens?: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ) => void;
  hydrateCompletedTurns: (sessionId: string, turns: CompletedTurn[]) => void;
  setCompletedTurns: (sessionId: string, turns: CompletedTurn[]) => void;
  toggleCompletedTurn: (sessionId: string, turnIndex: number) => void;
  appendToolActivityInput: (
    sessionId: string,
    toolUseId: string,
    partialJson: string,
  ) => void;
  chatDrafts: Record<string, string>;
  setChatDraft: (sessionId: string, draft: string) => void;
  clearChatDraft: (sessionId: string) => void;
  /** Per-session in-flight attachments staged in the composer before
   *  the message is sent. Stored here (not in `ChatInputArea`'s
   *  `useState`) so attachments survive any composer remount —
   *  including the unmount that happens when `<ChatPanel>` is
   *  conditionally rendered out of `AppLayout` after the user opens a
   *  file or diff (see comment at AppLayout.tsx:130-140). The
   *  `preview_url` field is intentionally absent from `StoredAttachment`
   *  because blob URLs are tied to the lifetime of the underlying Blob,
   *  which is GC'd on component unmount; the composer regenerates
   *  preview URLs from `data_base64` on mount. */
  pendingAttachmentsBySession: Record<string, StoredAttachment[]>;
  setPendingAttachmentsForSession: (
    sessionId: string,
    attachments: StoredAttachment[],
  ) => void;
  addPendingAttachment: (
    sessionId: string,
    attachment: StoredAttachment,
  ) => void;
  removePendingAttachment: (sessionId: string, attachmentId: string) => void;
  clearPendingAttachments: (sessionId: string) => void;
  lastMessages: Record<string, ChatMessage>;
  setLastMessages: (msgs: Record<string, ChatMessage>) => void;
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (
  set,
) => ({
  chatMessages: {},
  chatAttachments: {},
  setChatAttachments: (sessionId, attachments) =>
    set((s) => ({
      chatAttachments: { ...s.chatAttachments, [sessionId]: attachments },
    })),
  addChatAttachments: (sessionId, attachments) =>
    set((s) => ({
      chatAttachments: {
        ...s.chatAttachments,
        [sessionId]: [...(s.chatAttachments[sessionId] ?? []), ...attachments],
      },
    })),
  chatPagination: {},
  setChatPagination: (sessionId, state) =>
    set((s) => ({
      chatPagination: { ...s.chatPagination, [sessionId]: state },
    })),
  prependChatMessages: (sessionId, messages) =>
    set((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [sessionId]: [...messages, ...(s.chatMessages[sessionId] ?? [])],
      },
    })),
  prependChatAttachments: (sessionId, attachments) =>
    set((s) => {
      // Dedupe by id: when a page begins mid-turn, the page loader includes
      // the previous user message's anchor id so its attachments come back
      // again. Without this guard the same row would render twice once the
      // older page is loaded.
      const existing = s.chatAttachments[sessionId] ?? [];
      const seen = new Set(existing.map((a) => a.id));
      const fresh = attachments.filter((a) => !seen.has(a.id));
      if (fresh.length === 0) return {};
      return {
        chatAttachments: {
          ...s.chatAttachments,
          [sessionId]: [...fresh, ...existing],
        },
      };
    }),
  streamingContent: {},
  streamingThinking: {},
  pendingTypewriter: {},
  showThinkingBlocks: {},
  toolActivities: {},
  completedTurns: {},
  latestTurnUsage: {},
  setLatestTurnUsage: (sessionId, usage) =>
    set((s) => ({
      latestTurnUsage: { ...s.latestTurnUsage, [sessionId]: usage },
    })),
  clearLatestTurnUsage: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.latestTurnUsage)) return {};
      const next = { ...s.latestTurnUsage };
      delete next[sessionId];
      return { latestTurnUsage: next };
    }),
  promptStartTime: {},
  setPromptStartTime: (wsId, time) =>
    set((s) => ({
      promptStartTime: { ...s.promptStartTime, [wsId]: time },
    })),
  clearPromptStartTime: (wsId) =>
    set((s) => {
      if (!(wsId in s.promptStartTime)) return {};
      const next = { ...s.promptStartTime };
      delete next[wsId];
      return { promptStartTime: next };
    }),
  compactionEvents: {},
  setCompactionEvents: (sessionId, events) =>
    set((s) => ({
      compactionEvents: { ...s.compactionEvents, [sessionId]: events },
    })),
  addCompactionEvent: (sessionId, event) =>
    set((s) => ({
      compactionEvents: {
        ...s.compactionEvents,
        [sessionId]: [...(s.compactionEvents[sessionId] ?? []), event],
      },
    })),
  setChatMessages: (sessionId, messages) =>
    set((s) => ({
      chatMessages: { ...s.chatMessages, [sessionId]: messages },
    })),
  addChatMessage: (sessionId, message, options) =>
    set((s) => {
      const pagination = s.chatPagination[sessionId];
      const persisted = options?.persisted ?? true;
      return {
        chatMessages: {
          ...s.chatMessages,
          [sessionId]: [...(s.chatMessages[sessionId] || []), message],
        },
        lastMessages: { ...s.lastMessages, [sessionId]: message },
        // Keep totalCount in sync so globalOffset stays correct during streaming.
        // Client-only messages (no DB row) opt out so the count doesn't drift
        // ahead of the persisted set.
        ...(pagination && persisted
          ? {
              chatPagination: {
                ...s.chatPagination,
                [sessionId]: {
                  ...pagination,
                  totalCount: pagination.totalCount + 1,
                },
              },
            }
          : {}),
      };
    }),
  setStreamingContent: (sessionId, content) =>
    set((s) => ({
      streamingContent: { ...s.streamingContent, [sessionId]: content },
    })),
  appendStreamingContent: (sessionId, text) =>
    set((s) => ({
      streamingContent: {
        ...s.streamingContent,
        [sessionId]: (s.streamingContent[sessionId] || "") + text,
      },
    })),
  setPendingTypewriter: (sessionId, messageId, text) =>
    set((s) => ({
      pendingTypewriter: {
        ...s.pendingTypewriter,
        [sessionId]: { messageId, text },
      },
    })),
  finishTypewriterDrain: (sessionId) =>
    set((s) => ({
      pendingTypewriter: { ...s.pendingTypewriter, [sessionId]: null },
      streamingThinking: { ...s.streamingThinking, [sessionId]: "" },
    })),
  appendStreamingThinking: (sessionId, text) =>
    set((s) => ({
      streamingThinking: {
        ...s.streamingThinking,
        [sessionId]: (s.streamingThinking[sessionId] || "") + text,
      },
    })),
  clearStreamingThinking: (sessionId) =>
    set((s) => ({
      streamingThinking: { ...s.streamingThinking, [sessionId]: "" },
    })),
  setShowThinkingBlocks: (sessionId, show) =>
    set((s) => ({
      showThinkingBlocks: { ...s.showThinkingBlocks, [sessionId]: show },
    })),
  setToolActivities: (sessionId, activities) =>
    set((s) => ({
      toolActivities: { ...s.toolActivities, [sessionId]: activities },
    })),
  addToolActivity: (sessionId, activity) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [sessionId]: [...(s.toolActivities[sessionId] || []), activity],
      },
    })),
  updateToolActivity: (sessionId, toolUseId, updates) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [sessionId]: (s.toolActivities[sessionId] || []).map((a) =>
          a.toolUseId === toolUseId ? { ...a, ...updates } : a,
        ),
      },
    })),
  upsertAgentToolCall: (sessionId, agentId, call) => {
    let matched = false;
    set((s) => {
      const activities = s.toolActivities[sessionId] || [];
      const nextActivities = activities.map((activity) => {
        if (activity.agentTaskId !== agentId) return activity;
        matched = true;
        const calls = activity.agentToolCalls || [];
        const existing = calls.find((item) => item.toolUseId === call.toolUseId);
        const nextCalls = existing
          ? calls.map((item) =>
              item.toolUseId === call.toolUseId
                ? { ...item, ...call, startedAt: item.startedAt }
                : item,
            )
          : [...calls, call];
        return {
          ...activity,
          agentToolCalls: nextCalls,
          agentLastToolName: call.toolName,
          agentToolUseCount: Math.max(
            activity.agentToolUseCount ?? 0,
            nextCalls.length,
          ),
        };
      });
      return matched
        ? { toolActivities: { ...s.toolActivities, [sessionId]: nextActivities } }
        : {};
    });
    return matched;
  },
  toggleToolActivityCollapsed: (sessionId, index) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [sessionId]: (s.toolActivities[sessionId] || []).map((a, i) =>
          i === index ? { ...a, collapsed: !a.collapsed } : a,
        ),
      },
    })),
  appendToolActivityInput: (sessionId, toolUseId, partialJson) =>
    set((s) => ({
      toolActivities: {
        ...s.toolActivities,
        [sessionId]: (s.toolActivities[sessionId] || []).map((a) =>
          a.toolUseId === toolUseId
            ? { ...a, inputJson: a.inputJson + partialJson }
            : a,
        ),
      },
    })),
  finalizeTurn: (
    sessionId,
    messageCount,
    turnId,
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  ) =>
    set((s) => {
      // Phase 2.5: finalizeTurn no longer writes latestTurnUsage. The
      // meter needs per-call values, not the turn-aggregate we receive
      // here — useAgentStream's result handler calls setLatestTurnUsage
      // separately with the correct per-call data. The tokens we DO
      // receive here stay as CompletedTurn aggregate fields for the
      // TurnFooter's "turn-total work" view.
      const activities = s.toolActivities[sessionId] || [];
      if (activities.length === 0) {
        debugChat("store", "finalizeTurn skipped", {
          sessionId,
          messageCount,
          turnId: turnId ?? null,
          existingCompletedTurnIds: (s.completedTurns[sessionId] || []).map(
            (turn) => turn.id,
          ),
        });
        return {};
      }
      const loadedCount = (s.chatMessages[sessionId] || []).length;
      const pagination = s.chatPagination[sessionId];
      // For paginated sessions, afterMessageIndex must be the GLOBAL position
      // (i.e. totalCount) so the turn summary renders at the right spot even
      // when only a window of the message history is loaded.
      const afterMessageIndex = pagination
        ? pagination.totalCount
        : loadedCount;
      const turn: CompletedTurn = {
        id: turnId ?? crypto.randomUUID(),
        activities: activities.map((a) => ({
          toolUseId: a.toolUseId,
          toolName: a.toolName,
          inputJson: a.inputJson,
          resultText: a.resultText,
          collapsed: true,
          summary: a.summary,
          startedAt: a.startedAt,
          assistantMessageOrdinal: a.assistantMessageOrdinal,
          agentTaskId: a.agentTaskId,
          agentDescription: a.agentDescription,
          agentLastToolName: a.agentLastToolName,
          agentToolUseCount: a.agentToolUseCount,
          agentStatus: a.agentStatus,
          agentToolCalls: a.agentToolCalls,
        })),
        messageCount,
        collapsed: true,
        afterMessageIndex,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
      debugChat("store", "finalizeTurn", {
        sessionId,
        turnId: turn.id,
        messageCount,
        afterMessageIndex: turn.afterMessageIndex,
        toolCount: turn.activities.length,
        toolUseIds: turn.activities.map((activity) => activity.toolUseId),
        existingCompletedTurnIds: (s.completedTurns[sessionId] || []).map(
          (existingTurn) => existingTurn.id,
        ),
      });
      return {
        completedTurns: {
          ...s.completedTurns,
          [sessionId]: [...(s.completedTurns[sessionId] || []), turn],
        },
        toolActivities: { ...s.toolActivities, [sessionId]: [] },
      };
    }),
  hydrateCompletedTurns: (sessionId, turns) =>
    set((s) => {
      const existing = s.completedTurns[sessionId] || [];
      const existingById = new Map(existing.map((turn) => [turn.id, turn]));
      const incomingIds = new Set(turns.map((turn) => turn.id));

      const merged = turns.map((turn) => {
        const existingTurn = existingById.get(turn.id);
        if (!existingTurn) return turn;

        const existingActivitiesById = new Map(
          existingTurn.activities.map((activity) => [
            activity.toolUseId,
            activity,
          ]),
        );

        return {
          ...turn,
          collapsed: existingTurn.collapsed,
          activities: turn.activities.map((activity) => ({
            ...activity,
            collapsed:
              existingActivitiesById.get(activity.toolUseId)?.collapsed ??
              activity.collapsed,
          })),
        };
      });

      const pendingTurns = existing.filter((turn) => !incomingIds.has(turn.id));
      const nextTurns = [...merged, ...pendingTurns].sort(
        (a, b) => a.afterMessageIndex - b.afterMessageIndex,
      );

      debugChat("store", "hydrateCompletedTurns", {
        sessionId,
        existingIds: existing.map((turn) => turn.id),
        incomingIds: turns.map((turn) => turn.id),
        pendingIds: pendingTurns.map((turn) => turn.id),
        nextIds: nextTurns.map((turn) => turn.id),
      });

      return {
        completedTurns: {
          ...s.completedTurns,
          [sessionId]: nextTurns,
        },
      };
    }),
  setCompletedTurns: (sessionId, turns) =>
    set((s) => {
      debugChat("store", "setCompletedTurns", {
        sessionId,
        turnIds: turns.map((turn) => turn.id),
        previousIds: (s.completedTurns[sessionId] || []).map((turn) => turn.id),
      });
      return {
        completedTurns: { ...s.completedTurns, [sessionId]: turns },
      };
    }),
  toggleCompletedTurn: (sessionId, turnIndex) =>
    set((s) => ({
      completedTurns: {
        ...s.completedTurns,
        [sessionId]: (s.completedTurns[sessionId] || []).map((t, i) =>
          i === turnIndex ? { ...t, collapsed: !t.collapsed } : t,
        ),
      },
    })),
  chatDrafts: {},
  setChatDraft: (sessionId, draft) =>
    set((s) => ({
      chatDrafts: { ...s.chatDrafts, [sessionId]: draft },
    })),
  clearChatDraft: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.chatDrafts)) return s;
      const next = { ...s.chatDrafts };
      delete next[sessionId];
      return { chatDrafts: next };
    }),
  pendingAttachmentsBySession: {},
  setPendingAttachmentsForSession: (sessionId, attachments) =>
    set((s) => ({
      pendingAttachmentsBySession: {
        ...s.pendingAttachmentsBySession,
        [sessionId]: attachments,
      },
    })),
  addPendingAttachment: (sessionId, attachment) =>
    set((s) => {
      const existing = s.pendingAttachmentsBySession[sessionId] ?? [];
      // Functional add so concurrent paste/drop events serialize cleanly
      // even when the caller reads a stale local copy of the list.
      return {
        pendingAttachmentsBySession: {
          ...s.pendingAttachmentsBySession,
          [sessionId]: [...existing, attachment],
        },
      };
    }),
  removePendingAttachment: (sessionId, attachmentId) =>
    set((s) => {
      const existing = s.pendingAttachmentsBySession[sessionId];
      if (!existing) return s;
      const filtered = existing.filter((a) => a.id !== attachmentId);
      if (filtered.length === existing.length) return s;
      return {
        pendingAttachmentsBySession: {
          ...s.pendingAttachmentsBySession,
          [sessionId]: filtered,
        },
      };
    }),
  clearPendingAttachments: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.pendingAttachmentsBySession)) return s;
      const next = { ...s.pendingAttachmentsBySession };
      delete next[sessionId];
      return { pendingAttachmentsBySession: next };
    }),
  lastMessages: {},
  setLastMessages: (msgs) => set({ lastMessages: msgs }),
});
