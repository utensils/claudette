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

/** Persist the workflow progress tree for a single already-checkpointed
 *  activity. Used when a backgrounded `Workflow` finishes after the turn
 *  that launched it was already saved.
 *
 *  Both fields are optional and COALESCE against the stored row: pass
 *  `null` for either to leave it untouched. A run that ends without ever
 *  reporting agents still needs its status resolved, and must not blank
 *  the tree on the way.
 *
 *  `chatSessionId` scopes a terminal write to one activity. Forking copies
 *  `tool_use_id` verbatim into the fork's rows, so an unscoped write would
 *  rewrite the copied history in every fork of the session. */
export function updateTurnToolActivityProgress(
  toolUseId: string,
  workflowProgressJson: string | null,
  agentStatus: string | null,
  chatSessionId: string,
): Promise<void> {
  return invoke("update_turn_tool_activity_progress", {
    toolUseId,
    workflowProgressJson,
    agentStatus,
    chatSessionId,
  });
}

export function loadCompletedTurns(
  sessionId: string,
): Promise<CompletedTurnData[]> {
  return invoke("load_completed_turns", { sessionId });
}
