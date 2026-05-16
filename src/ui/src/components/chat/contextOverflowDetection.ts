/**
 * Detect "the model's context window is too small" errors surfaced
 * from any agent harness.
 *
 * Why a string-matcher and not a structured error variant?
 *
 * The error path through Tauri is `Result<(), String>` — every
 * harness's failure mode collapses into a plain string before it
 * reaches the UI. The gateway's Rust side already has a near-
 * identical matcher at
 * `src-tauri/src/commands/agent_backends/gateway_translate.rs::
 * upstream_message_is_permanent_failure`, scoped to the broader
 * "permanent failure" class (also includes "model not loaded" etc).
 *
 * This helper picks out the *context-window* subset so the UI can
 * offer the right recovery action — "pick a larger-context model"
 * is meaningless for a missing-model error. Keep the needle list in
 * lock-step with the Rust side: if a new upstream variant shows up
 * (e.g. a new OpenAI-compatible local server), add it in both places
 * so the gateway demotes it from 5xx to 4xx AND the UI can route the
 * user to a recovery.
 *
 * Patterns observed in the wild:
 *   - Anthropic: "Input is too long for requested model"
 *   - OpenAI:   "This model's maximum context length is 8192 tokens"
 *               "Your prompt is X tokens, exceeds the maximum"
 *   - LM Studio: "Trying to keep N tokens to keep, but the context window is M"
 *   - Codex:    "Context window exceeded"
 *   - Pi (varied, passes through provider text):
 *               "prompt is too long",
 *               "context length", etc.
 */
const CONTEXT_OVERFLOW_NEEDLES: readonly string[] = [
  "context length",
  "tokens to keep",
  "context window",
  "exceeds the maximum",
  "input is too long",
  "prompt is too long",
];

export function isContextWindowError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_NEEDLES.some((needle) => lower.includes(needle));
}
