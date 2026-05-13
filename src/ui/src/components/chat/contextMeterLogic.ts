import type { TurnUsage } from "../../stores/useAppStore";

export type Band = "normal" | "warn" | "near-full" | "critical";

export interface MeterState {
  totalTokens: number;
  capacity: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Bar fill width, capped at 100. Use for the fill element's CSS width. */
  fillPercent: number;
  /** Displayed percentage, uncapped — can exceed 100 when a turn goes over
   *  the context window. Use for text labels / tooltip (e.g. "105%"). */
  percentRounded: number;
  band: Band;
}

/** Thresholds per the Phase 2 spec: 60 / 80 / 90 % */
export function bandForRatio(ratio: number): Band {
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.8) return "near-full";
  if (ratio >= 0.6) return "warn";
  return "normal";
}

/**
 * Compute everything the ContextMeter component needs to render, or null
 * if the meter should be hidden. Returning null (rather than throwing)
 * covers: no turn yet, pre-migration turn missing token metadata, and
 * stale model ids with zero/undefined capacity.
 *
 * Uses `Number.isFinite` for the token guards so `NaN` values from
 * unexpected deserialization paths are treated the same as missing data.
 */
export function computeMeterState(
  usage: TurnUsage | undefined,
  capacity: number | undefined,
): MeterState | null {
  if (!usage) return null;
  if (!Number.isFinite(usage.inputTokens)) return null;
  if (!Number.isFinite(usage.outputTokens)) return null;
  const runtimeCapacity = Number.isFinite(usage.modelContextWindow)
    ? usage.modelContextWindow
    : undefined;
  const resolvedCapacity = runtimeCapacity ?? capacity;
  if (!Number.isFinite(resolvedCapacity) || (resolvedCapacity as number) <= 0) return null;

  const cap = resolvedCapacity as number;
  const input = usage.inputTokens as number;
  const output = usage.outputTokens as number;
  // `?? 0` only replaces null/undefined — NaN would pass through and
  // poison totalTokens / fillPercent / the tooltip. Number.isFinite
  // treats undefined, null, and NaN uniformly as "missing".
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? (usage.cacheReadTokens as number) : 0;
  const cacheCreation = Number.isFinite(usage.cacheCreationTokens) ? (usage.cacheCreationTokens as number) : 0;
  const totalTokens = Number.isFinite(usage.totalTokens)
    ? usage.totalTokens as number
    : input + cacheRead + cacheCreation + output;
  const ratio = totalTokens / cap;
  const fillPercent = Math.min(ratio, 1) * 100;
  const percentRounded = Math.round(ratio * 100);
  const band = bandForRatio(ratio);

  return {
    totalTokens,
    capacity: cap,
    input,
    output,
    cacheRead,
    cacheCreation,
    fillPercent,
    percentRounded,
    band,
  };
}

const LOCALE = "en-US";

/**
 * Build the multi-line tooltip string shown on hover. Accepts a `MeterState`
 * directly (no re-derivation) so the tooltip can never disagree with what
 * the meter shows. Uses `en-US` locale explicitly so the thousand separator
 * is a comma regardless of the user's system locale — matches the readout
 * style and keeps tests deterministic.
 */
export function buildMeterTooltip(state: MeterState): string {
  return [
    `Context: ${state.totalTokens.toLocaleString(LOCALE)} / ${state.capacity.toLocaleString(LOCALE)} tokens (${state.percentRounded}%)`,
    "",
    `Input: ${state.input.toLocaleString(LOCALE)}`,
    `Cache read: ${state.cacheRead.toLocaleString(LOCALE)}`,
    `Cache creation: ${state.cacheCreation.toLocaleString(LOCALE)}`,
    `Output: ${state.output.toLocaleString(LOCALE)}`,
  ].join("\n");
}
