import type {
  AgentBackendConfig,
  AgentBackendKind,
} from "../../../services/tauri/agentBackends";

/**
 * What the composer's usage indicator should do for the active session.
 *
 *  - `"active"`   — render the live meter (Claude Code via ptywright,
 *                   Codex Native, OpenAI/OpenRouter/Pi/Ollama/LM Studio).
 *  - `"hidden"`   — render nothing. Used while the backend list is still
 *                   loading (no config yet for the session's selected
 *                   backend id).
 */
export type UsageIndicatorMode = "active" | "hidden";

/**
 * Backend kinds whose usage source is the official Claude Code `/usage`
 * screen, read through ptywright.
 *
 * Membership rule: the backend should surface Claude Code subscription
 * quotas. Codex Subscription uses Codex CLI auth — a completely
 * different credential ecosystem — so it does NOT belong here even
 * though its default harness is `claude_code`. Same reasoning extends
 * to OpenAI / Custom OpenAI / Ollama / LM Studio: gateway-translated,
 * not Claude Code subscription usage.
 *
 * `custom_anthropic` stays in for backward compatibility: users who
 * have Claude Code signed in locally still get a meaningful reading.
 */
const CLAUDE_FAMILY_KINDS: ReadonlySet<AgentBackendKind> = new Set([
  "anthropic",
  "custom_anthropic",
]);

/**
 * Backend kinds that render local/provider usage. Codex Subscription
 * joins this group because its auth + quota live on the Codex side.
 */
const ALWAYS_ACTIVE_KINDS: ReadonlySet<AgentBackendKind> = new Set([
  "codex_native",
  "codex_subscription",
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
 *  - Kind in [`CLAUDE_FAMILY_KINDS`] → `"active"`.
 *  - Kind in [`ALWAYS_ACTIVE_KINDS`] → `"active"`.
 *  - Unknown kind → `"hidden"` (defensive — don't paint a meter we
 *    don't know how to populate).
 */
export function resolveIndicatorMode(
  backend: AgentBackendConfig | null | undefined,
): UsageIndicatorMode {
  if (!backend) return "hidden";

  const kind = backend.kind;

  if (CLAUDE_FAMILY_KINDS.has(kind)) {
    return "active";
  }

  if (ALWAYS_ACTIVE_KINDS.has(kind)) {
    return "active";
  }

  return "hidden";
}
