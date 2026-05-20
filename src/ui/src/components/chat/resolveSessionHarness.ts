import type {
  AgentBackendConfig,
  AgentBackendRuntimeHarness,
} from "../../services/tauri/agentBackends";
import {
  availableHarnessesForKind,
  defaultHarnessForKind,
  effectiveHarness,
} from "../../services/tauri/agentBackends";

/**
 * Resolve the runtime harness for a chat session using the same fallback
 * chain the Rust send pipeline applies: explicit per-session provider →
 * org default backend id → first available backend. Returns `null` only
 * when the backend list is genuinely empty (e.g. agent_backends hasn't
 * loaded yet). Callers should treat `null` as "don't know — be
 * conservative" (disable destructive actions, fail closed) rather than
 * assuming a specific harness.
 *
 * Mirrors `resolve_dispatch_harness` for the Pi downgrade case: a non-Pi
 * backend (Ollama, LM Studio, OpenAI, …) configured to dispatch through
 * Pi gets downgraded to the first non-Pi allowed harness when no enabled
 * Pi card exists, so the resolved harness matches the harness the Rust
 * send pipeline will actually run.
 *
 * Used by `ChatPanel`'s `/compact` dispatch purely as a readiness guard:
 * a `null` result means `agent_backends` hasn't loaded yet, so `/compact`
 * should surface a "backend not ready" notice rather than fire blind.
 * Every harness (Claude Code, Codex Native, Pi SDK) supports `/compact`,
 * so the resolved harness value itself no longer gates the command.
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
  const harness = effectiveHarness(backend);
  if (harness !== "pi_sdk") return harness;
  // The Pi card itself stays "pi_sdk" — its own `enabled` check is
  // enforced upstream (the resolver gives up on disabled backends).
  if (backend.kind === "pi_sdk") return harness;
  const piAvailable = agentBackends.some(
    (other) => other.kind === "pi_sdk" && other.enabled,
  );
  if (piAvailable) return harness;
  return (
    availableHarnessesForKind(backend.kind).find(
      (candidate) => candidate !== "pi_sdk",
    ) ?? defaultHarnessForKind(backend.kind)
  );
}
