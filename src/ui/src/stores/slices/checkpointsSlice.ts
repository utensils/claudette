import type { StateCreator } from "zustand";
import type { ChatMessage, ConversationCheckpoint } from "../../types";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import type { AppState } from "../useAppStore";

export interface CheckpointsSlice {
  checkpoints: Record<string, ConversationCheckpoint[]>;
  setCheckpoints: (wsId: string, cps: ConversationCheckpoint[]) => void;
  addCheckpoint: (wsId: string, cp: ConversationCheckpoint) => void;
  rollbackConversation: (
    sessionId: string,
    workspaceId: string,
    checkpointId: string,
    messages: ChatMessage[],
  ) => void;
}

export const createCheckpointsSlice: StateCreator<
  AppState,
  [],
  [],
  CheckpointsSlice
> = (set) => ({
  checkpoints: {},
  setCheckpoints: (wsId, cps) =>
    set((s) => ({
      checkpoints: { ...s.checkpoints, [wsId]: cps },
    })),
  addCheckpoint: (wsId, cp) =>
    set((s) => ({
      checkpoints: {
        ...s.checkpoints,
        [wsId]: [...(s.checkpoints[wsId] || []), cp],
      },
    })),
  rollbackConversation: (sessionId, workspaceId, checkpointId, messages) =>
    set((s) => {
      const { [sessionId]: _q, ...restQuestions } = s.agentQuestions;
      const { [sessionId]: _p, ...restApprovals } = s.planApprovals;
      const { [workspaceId]: _cs, ...restChatSearch } = s.chatSearch;
      // Update lastMessages so workspace preview cards stay in sync.
      const lastMsg =
        messages.length > 0 ? messages[messages.length - 1] : undefined;
      const { [workspaceId]: _lm, ...restLastMessages } = s.lastMessages;
      const updatedLastMessages = lastMsg
        ? { ...s.lastMessages, [workspaceId]: lastMsg }
        : restLastMessages;
      // Recompute the meter's latestTurnUsage from the rolled-back message
      // list. Write if the last assistant message has token data; delete
      // the entry otherwise so the meter hides.
      const nextCall = extractLatestCallUsage(messages);
      let latestTurnUsage = s.latestTurnUsage;
      if (nextCall) {
        latestTurnUsage = { ...s.latestTurnUsage, [sessionId]: nextCall };
      } else if (sessionId in s.latestTurnUsage) {
        const next = { ...s.latestTurnUsage };
        delete next[sessionId];
        latestTurnUsage = next;
      }
      const nextCompactionEvents = {
        ...s.compactionEvents,
        [sessionId]: extractCompactionEvents(messages),
      };
      return {
        chatMessages: { ...s.chatMessages, [sessionId]: messages },
        lastMessages: updatedLastMessages,
        completedTurns: { ...s.completedTurns, [sessionId]: [] },
        toolActivities: { ...s.toolActivities, [sessionId]: [] },
        streamingContent: { ...s.streamingContent, [sessionId]: "" },
        streamingThinking: { ...s.streamingThinking, [sessionId]: "" },
        agentQuestions: restQuestions,
        planApprovals: restApprovals,
        chatSearch: restChatSearch,
        checkpoints: {
          ...s.checkpoints,
          [sessionId]: (() => {
            const current = s.checkpoints[sessionId] || [];
            const target = current.find((c) => c.id === checkpointId);
            // If target not found (e.g. clear-all sentinel), clear everything.
            if (!target) return [];
            return current.filter((cp) => cp.turn_index <= target.turn_index);
          })(),
        },
        latestTurnUsage,
        compactionEvents: nextCompactionEvents,
      };
    }),
});
