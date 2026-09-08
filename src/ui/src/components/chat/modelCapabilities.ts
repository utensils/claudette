/** Built-in Claude models that support fast mode (research preview: Claude Opus 5 / Opus 4.8 only).
 *  `opus` now resolves to Opus 5; the demoted `claude-opus-4-8` ids keep the
 *  capability they had when `opus` pointed at them. */
const FAST_SUPPORTED_MODELS = new Set(["opus", "claude-opus-4-8", "claude-opus-4-8[1m]"]);

/** Models that support effort levels. */
const EFFORT_SUPPORTED_MODELS = new Set(["opus", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"]);

/** Models that support the "xhigh" effort level (Opus 4.7+, Fable 5+, and Sonnet 5).
 *  Sonnet 5 (the `sonnet` alias, natively 1M) gained xhigh — the demoted
 *  Sonnet 4.6 ids deliberately stay out. */
const XHIGH_EFFORT_MODELS = new Set(["opus", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "sonnet"]);

/** Models that support the "max" effort level. */
const MAX_EFFORT_MODELS = new Set(["opus", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"]);

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
