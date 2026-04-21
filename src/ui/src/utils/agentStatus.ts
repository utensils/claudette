import type { AgentStatus } from "../types/workspace";

/**
 * Returns true when the agent is actively occupied — either running a
 * request/response cycle or performing a /compact boundary compaction.
 * Both states should disable the chat input, advance the shared spinner
 * animation, and block actions that assume an idle agent.
 */
export function isAgentBusy(status: AgentStatus | undefined | null): boolean {
  return status === "Running" || status === "Compacting";
}
