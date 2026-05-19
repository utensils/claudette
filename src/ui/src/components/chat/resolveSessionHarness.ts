import type {
  AgentBackendConfig,
  AgentBackendRuntimeHarness,
} from "../../services/tauri/agentBackends";
import { effectiveHarness } from "../../services/tauri/agentBackends";

/**
 * Resolve the runtime harness for a chat session using the same fallback
 * chain the Rust send pipeline applies: explicit per-session provider →
 * org default backend id → first available backend. Returns `null` only
 * when the backend list is genuinely empty (e.g. agent_backends hasn't
 * loaded yet). Callers should treat `null` as "don't know — be
 * conservative" (disable destructive actions, fail closed) rather than
 * assuming a specific harness.
 *
 * Used by both `ChatPanel`'s `/compact` dispatch and `ContextPopover`'s
 * "Compact" button gate so the two surfaces stay in sync — if either
 * silently assumed `claude_code` while the session was actually running
 * on Pi (a real `selectedModelProvider[sessionId] === undefined` case
 * after first launch), Pi compact text would either misroute through the
 * Codex intercept or hit the wrong "not supported" path.
 */
export function resolveSessionHarness(args: {
  sessionId: string;
  selectedModelProvider: Record<string, string | undefined>;
  agentBackends: AgentBackendConfig[];
  defaultAgentBackendId: string;
}): AgentBackendRuntimeHarness | null {
  const { sessionId, selectedModelProvider, agentBackends, defaultAgentBackendId } = args;
  if (agentBackends.length === 0) return null;
  const providerId =
    selectedModelProvider[sessionId] ?? defaultAgentBackendId;
  const backend =
    agentBackends.find((b) => b.id === providerId) ??
    agentBackends.find((b) => b.id === defaultAgentBackendId) ??
    agentBackends[0];
  if (!backend) return null;
  return effectiveHarness(backend);
}
