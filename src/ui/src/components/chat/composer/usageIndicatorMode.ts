import type {
  AgentBackendConfig,
  AgentBackendKind,
} from "../../../services/tauri/agentBackends";

/**
 * What the composer's usage indicator should do for the active session.
 *
 *  - `"active"`   — render the live meter (Codex Native, OpenAI/OpenRouter/
 *                   Pi/Ollama/LM Studio, or a Claude-family backend when the
 *                   experimental Claude Code Usage flag is on).
 *  - `"disabled"` — render the greyed-out battery; click opens Settings →
 *                   Experimental → Claude Code Usage. Used when the active
 *                   backend is Claude-family but the flag is off.
 *  - `"hidden"`   — render nothing. Used while the backend list is still
 *                   loading (no config yet for the session's selected
 *                   backend id).
 */
export type UsageIndicatorMode = "active" | "disabled" | "hidden";

/**
 * Backend kinds that route through the Anthropic OAuth Usage API path
 * (subscription quotas, gated behind the experimental Claude Code Usage
 * flag).
 *
 * Crucially, OpenAI / Custom OpenAI / Ollama / LM Studio are NOT in
 * this set, even though their default harness is `claude_code` —
 * they use the gateway-translation path, not OAuth. Their usage
 * indicator runs on the local-aggregate source (tokens recorded per
 * turn) and is always enabled.
 */
const CLAUDE_FAMILY_KINDS: ReadonlySet<AgentBackendKind> = new Set([
  "anthropic",
  "custom_anthropic",
  "codex_subscription",
]);

/**
 * Backend kinds that always render the live meter regardless of the
 * experimental flag. These rely on local-aggregate data (plus
 * provider-specific extras for Codex Native and OpenRouter) — no
 * subscription credential is in play.
 */
const ALWAYS_ACTIVE_KINDS: ReadonlySet<AgentBackendKind> = new Set([
  "codex_native",
  "openai_api",
  "custom_openai",
  "ollama",
  "lm_studio",
  "pi_sdk",
]);

/**
 * Classify the indicator render mode for a given backend.
 *
 *  - `backend == null` → `"hidden"` (backend list still loading).
 *  - Kind in [`CLAUDE_FAMILY_KINDS`] → gated by `claudeCodeUsageEnabled`
 *    (`"active"` when true, `"disabled"` when false).
 *  - Kind in [`ALWAYS_ACTIVE_KINDS`] → `"active"` regardless of the flag.
 *  - Unknown kind → `"hidden"` (defensive — don't paint a meter we
 *    don't know how to populate).
 */
export function resolveIndicatorMode(
  backend: AgentBackendConfig | null | undefined,
  claudeCodeUsageEnabled: boolean,
): UsageIndicatorMode {
  if (!backend) return "hidden";

  const kind = backend.kind;

  if (CLAUDE_FAMILY_KINDS.has(kind)) {
    return claudeCodeUsageEnabled ? "active" : "disabled";
  }

  if (ALWAYS_ACTIVE_KINDS.has(kind)) {
    return "active";
  }

  return "hidden";
}
