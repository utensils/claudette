import { invoke } from "@tauri-apps/api/core";
import type { SubagentRun } from "../../types/subagent";
import { sendRemoteCommand } from "./remote";

export function getSubagentRuns(sessionId: string, connectionId: string | null): Promise<SubagentRun[]> {
  if (connectionId) {
    return sendRemoteCommand(connectionId, "get_subagent_runs", {
      chat_session_id: sessionId,
    }) as Promise<SubagentRun[]>;
  }
  return invoke("get_subagent_runs", { sessionId });
}

export interface SubagentControl {
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export async function getPendingSubagentControls(sessionId: string, connectionId: string | null): Promise<SubagentControl[]> {
  if (!connectionId) return invoke("get_pending_subagent_controls", { sessionId });
  const snapshot = await sendRemoteCommand(connectionId, "get_chat_snapshot", {
    chat_session_id: sessionId, limit: 1,
  }) as { pending_controls?: (SubagentControl & { child_owned?: boolean })[] };
  return snapshot?.pending_controls?.filter((entry) => entry.child_owned) ?? [];
}
