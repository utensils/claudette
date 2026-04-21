import type { ChatMessage } from "../types/chat";
import type { TurnUsage } from "../stores/useAppStore";
import { parseCompactionSentinel } from "./compactionSentinel";

/**
 * Find the most recent usage baseline in `messages` and return it as a
 * `TurnUsage`. Returns `null` if no such message exists (fresh workspace,
 * pre-migration history, etc.).
 *
 * Two sources are recognised, checked in reverse-chronological order so the
 * most recent wins:
 *
 * - **Assistant message** with at least one of `input_tokens` / `output_tokens`
 *   populated — Phase 1's bridge writes these from `message_delta.usage`.
 * - **COMPACTION sentinel** (`role === "System"`, content starts with
 *   `COMPACTION:`) — persisted by the Tauri bridge on a `compact_boundary`
 *   event. On workspace reload this is used to drop the ContextMeter to the
 *   post-compaction baseline (`postTokens` surfaced as `cacheReadTokens`).
 *   After compaction the summary becomes the cached context, so it will be
 *   read as `cache_read_tokens` on the next API call — mapping it here keeps
 *   the meter formula `(input + cache_read + cache_creation) / 200k` correct.
 *   `inputTokens` and `outputTokens` are set to `0` rather than `undefined`
 *   because `computeMeterState` hides the meter entirely if either field is
 *   non-finite — zeros are explicit "known to be reset" values.
 *
 * Used by the ContextMeter's reconstructed-path hydration.
 */
export function extractLatestCallUsage(
  messages: ChatMessage[],
): TurnUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "System") {
      const parsed = parseCompactionSentinel(m.content);
      if (parsed !== null) {
        return {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: parsed.postTokens,
          cacheCreationTokens: undefined,
        };
      }
      continue;
    }
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
