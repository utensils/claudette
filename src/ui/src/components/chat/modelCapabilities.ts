/** Built-in Claude models that support fast mode. Generally available on Fable 5.2 and
 *  Opus 5.5; still a research preview on Opus 5 / Opus 4.8. `opus` now resolves to Opus
 *  5.5; the demoted `claude-opus-5` and `claude-opus-4-8` ids keep the capability they
 *  had when `opus` pointed at them. Fable 5.1 and earlier Fables never had fast mode. */
const FAST_SUPPORTED_MODELS = new Set(["opus", "claude-fable-5-2", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-8[1m]"]);

/** Models that support effort levels. */
const EFFORT_SUPPORTED_MODELS = new Set(["opus", "claude-fable-5-2", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"]);

/** Models that support the "xhigh" effort level (Opus 4.7+, Fable 5+, and Sonnet 5).
 *  Sonnet 5 (the `sonnet` alias, natively 1M) gained xhigh — the demoted
 *  Sonnet 4.6 ids deliberately stay out. */
const XHIGH_EFFORT_MODELS = new Set(["opus", "claude-fable-5-2", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "sonnet"]);

/** Models that support the "max" effort level. */
const MAX_EFFORT_MODELS = new Set(["opus", "claude-fable-5-2", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-8[1m]", "claude-fable-5-1", "claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-6", "claude-opus-4-6[1m]", "sonnet", "claude-sonnet-4-6", "claude-sonnet-4-6[1m]"]);

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
