import type { AgentBackendConfig } from "../../services/tauri/agentBackends";

export interface ResolveSessionBackendArgs {
  sessionId: string;
  selectedModelProvider: Record<string, string | undefined>;
  agentBackends: readonly AgentBackendConfig[];
  defaultAgentBackendId: string;
}

/**
 * Resolve the backend for a chat session using the same fallback chain
 * the send/runtime path applies: explicit per-session provider,
 * configured default backend, then first loaded backend.
 */
export function resolveSessionBackend({
  sessionId,
  selectedModelProvider,
  agentBackends,
  defaultAgentBackendId,
}: ResolveSessionBackendArgs): AgentBackendConfig | null {
  if (agentBackends.length === 0) return null;
  const providerId = selectedModelProvider[sessionId] ?? defaultAgentBackendId;
  return (
    agentBackends.find((backend) => backend.id === providerId) ??
    agentBackends.find((backend) => backend.id === defaultAgentBackendId) ??
    agentBackends[0] ??
    null
  );
}
