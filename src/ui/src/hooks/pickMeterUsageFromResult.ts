import type { StreamEvent } from "../types/agent-events";
import type { TurnUsage } from "../stores/useAppStore";

type ResultEvent = Extract<StreamEvent, { type: "result" }>;

/**
 * Pick the per-call usage for the ContextMeter from a `result` stream event.
 *
 * `result.usage.iterations[0]` contains the final API call's per-call usage
 * (what the meter needs to show actual end-of-turn context size). The
 * top-level `result.usage.*` fields aggregate across all internal tool-use
 * iterations and are `num_turns ×` too large for the meter's purposes.
 *
 * Returns null when no usable data is available — fresh turn with no usage
 * payload, or CLI emitted `usage: null`. Falls back to the top-level
 * aggregate when `iterations` is absent (older CLI versions that don't
 * emit the field); the meter will over-report on tool-use chains in that
 * case but still renders a reasonable value for single-iteration turns.
 */
export function pickMeterUsageFromResult(
  event: ResultEvent,
): TurnUsage | null {
  const source = event.usage?.iterations?.[0] ?? event.usage;
  if (!source) return null;
  if (
    typeof source.input_tokens !== "number" &&
    typeof source.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    totalTokens: source.total_tokens ?? undefined,
    inputTokens: source.input_tokens,
    outputTokens: source.output_tokens,
    cacheReadTokens: source.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: source.cache_creation_input_tokens ?? undefined,
    modelContextWindow: source.model_context_window ?? undefined,
  };
}
