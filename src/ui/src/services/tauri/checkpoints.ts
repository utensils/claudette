import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "../../types";
import type {
  CompletedTurnData,
  ConversationCheckpoint,
  TurnToolActivityData,
} from "../../types/checkpoint";

export function listCheckpoints(
  sessionId: string,
): Promise<ConversationCheckpoint[]> {
  return invoke("list_checkpoints", { sessionId });
}

export function rollbackToCheckpoint(
  sessionId: string,
  checkpointId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("rollback_to_checkpoint", {
    sessionId,
    checkpointId,
    restoreFiles,
  });
}

export function clearConversation(
  sessionId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("clear_conversation", {
    sessionId,
    restoreFiles,
  });
}

export function saveTurnToolActivities(
  checkpointId: string,
  messageCount: number,
  activities: TurnToolActivityData[],
): Promise<void> {
  return invoke("save_turn_tool_activities", {
    checkpointId,
    messageCount,
    activities,
  });
}

export function loadCompletedTurns(
  sessionId: string,
): Promise<CompletedTurnData[]> {
  return invoke("load_completed_turns", { sessionId });
}
