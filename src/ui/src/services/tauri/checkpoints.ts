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

/** Resolve `Workflow` activities this session left mid-run, when it has no
 *  CLI process that could still own them.
 *
 *  The boot sweep only runs at process start, so a wedged status pill
 *  survives a webview reload — without this the user has to fully quit and
 *  relaunch to clear one. Rust decides whether the sweep is safe: it checks
 *  the session's `persistent_session`, and returns 0 without touching
 *  anything when a process is alive. Resolves to the number of rows fixed. */
export function resolveStaleWorkflowActivities(
  sessionId: string,
): Promise<number> {
  return invoke("resolve_stale_workflow_activities", { sessionId });
}

/** Late-arriving fields for an already-checkpointed `Agent` activity.
 *  `null`/omitted fields leave the stored column untouched (COALESCE). */
export interface AgentActivityUpdate {
  agentStatus?: string | null;
  agentResultText?: string | null;
  agentToolCallsJson?: string | null;
  agentThinkingBlocksJson?: string | null;
  agentToolUseCount?: number | null;
  agentTotalTokens?: number | null;
  agentDurationMs?: number | null;
}

/** Persist a background subagent's outcome onto its activity row. Needed
 *  because a `run_in_background` Agent finishes after its launching turn was
 *  checkpointed — the same lifecycle `updateTurnToolActivityProgress` covers
 *  for workflows. Session-scoped (forks copy `tool_use_id`). */
export function updateTurnAgentActivity(
  chatSessionId: string,
  toolUseId: string,
  update: AgentActivityUpdate,
): Promise<void> {
  return invoke("update_turn_agent_activity", {
    chatSessionId,
    toolUseId,
    update,
  });
}

export function loadCompletedTurns(
  sessionId: string,
): Promise<CompletedTurnData[]> {
  return invoke("load_completed_turns", { sessionId });
}
