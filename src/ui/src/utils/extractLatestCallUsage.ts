import type { ChatMessage } from "../types/chat";
import type { TurnUsage } from "../stores/useAppStore";

/**
 * Find the last assistant message in `messages` that has at least one of
 * `input_tokens` / `output_tokens` populated, and return its per-message
 * token fields as a `TurnUsage`. Returns `null` if no such message exists
 * (fresh workspace, pre-migration history, etc.).
 *
 * Phase 1's bridge writes these per-message fields from `message_delta.usage`,
 * which is per-API-call — so the returned `TurnUsage` is the real end-of-turn
 * context size, not an aggregate across iterations. Used by the ContextMeter's
 * reconstructed-path hydration.
 */
export function extractLatestCallUsage(
  messages: ChatMessage[],
): TurnUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "Assistant") continue;
    if (m.input_tokens === null && m.output_tokens === null) continue;
    return {
      inputTokens: m.input_tokens ?? undefined,
      outputTokens: m.output_tokens ?? undefined,
      cacheReadTokens: m.cache_read_tokens ?? undefined,
      cacheCreationTokens: m.cache_creation_tokens ?? undefined,
    };
  }
  return null;
}
