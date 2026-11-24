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
