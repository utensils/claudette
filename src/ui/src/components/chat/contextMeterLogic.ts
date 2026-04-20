import type { CompletedTurn } from "../../stores/useAppStore";

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
  turn: CompletedTurn | undefined,
  capacity: number | undefined,
): MeterState | null {
  if (!turn) return null;
  if (!Number.isFinite(turn.inputTokens)) return null;
  if (!Number.isFinite(turn.outputTokens)) return null;
  if (!Number.isFinite(capacity) || (capacity as number) <= 0) return null;

  const cap = capacity as number;
  const input = turn.inputTokens as number;
  const output = turn.outputTokens as number;
  // `?? 0` only replaces null/undefined — NaN would pass through and
  // poison totalTokens / fillPercent / the tooltip. Number.isFinite
  // treats undefined, null, and NaN uniformly as "missing".
  const cacheRead = Number.isFinite(turn.cacheReadTokens) ? (turn.cacheReadTokens as number) : 0;
  const cacheCreation = Number.isFinite(turn.cacheCreationTokens) ? (turn.cacheCreationTokens as number) : 0;
  const totalTokens = input + cacheRead + cacheCreation + output;
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
