/** Built-in Claude models that support fast mode. Provider models use backend capabilities. */
const FAST_SUPPORTED_MODELS = new Set(["claude-opus-4-6", "claude-opus-4-6[1m]"]);

/** Models that support effort levels. */
const EFFORT_SUPPORTED_MODELS = new Set(["opus", "claude-opus-4-8", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6[1m]"]);

/** Models that support the "xhigh" effort level (Opus 4.7+ and Fable 5). */
const XHIGH_EFFORT_MODELS = new Set(["opus", "claude-opus-4-8", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]"]);

/** Models that support the "max" effort level. */
const MAX_EFFORT_MODELS = new Set(["opus", "claude-opus-4-8", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6[1m]"]);

/** Models that support the "ultracode" effort tier (xhigh + standing
 *  dynamic-workflow orchestration). Gated to Opus 4.8 — the `opus` alias
 *  currently resolves to Opus 4.8 1M and `claude-opus-4-8` is the 200k pin. */
const ULTRACODE_SUPPORTED_MODELS = new Set(["opus", "claude-opus-4-8"]);

export function isFastSupported(model: string): boolean {
  return FAST_SUPPORTED_MODELS.has(model);
}

export function isEffortSupported(model: string): boolean {
  return EFFORT_SUPPORTED_MODELS.has(model);
}

export function isXhighEffortAllowed(model: string): boolean {
  return XHIGH_EFFORT_MODELS.has(model);
}

export function isMaxEffortAllowed(model: string): boolean {
  return MAX_EFFORT_MODELS.has(model);
}

/** Whether the Ultracode composer toggle should be offered for `model`.
 *  Only Opus 4.8 is xhigh-capable *and* product-gated for ultracode. */
export function isUltracodeSupported(model: string): boolean {
  return ULTRACODE_SUPPORTED_MODELS.has(model);
}
