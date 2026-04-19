import { useEffect, useRef, useState } from "react";

export const TYPEWRITER_BASE_RATE = 60;
export const TYPEWRITER_MAX_LAG_MS = 200;

export interface UseTypewriterOptions {
  /** Base reveal rate in chars/sec. Default 60. */
  baseRate?: number;
  /** Max lag in ms before we accelerate. Default 200. */
  maxLagMs?: number;
  /** When false, the RAF loop is paused and fullText is returned as-is.
   *  Transitioning to true snaps revealed to fullText.length so only new
   *  text arriving after enable gets the typewriter effect. Default true. */
  enabled?: boolean;
}

export interface UseTypewriterResult {
  /** The substring to render right now. */
  displayed: string;
  /** Whether to show the blinking caret. */
  showCaret: boolean;
}

export interface TypewriterState {
  /** Float accumulator — sub-character fractions are preserved across frames. */
  revealed: number;
  /** Latched target text; sticks at the last non-empty fullText seen. */
  target: string;
}

export interface TickParams {
  state: TypewriterState;
  fullText: string;
  deltaMs: number;
  baseRate: number;
  maxLagMs: number;
}

// Target latches at the highest-seen non-empty fullText so the hook can keep
// draining after the source string clears (e.g. when streamingContent resets
// but the just-added completed message is still hidden behind pendingTypewriter).
export function computeNextState(params: TickParams): TypewriterState {
  const { state, fullText, deltaMs, baseRate, maxLagMs } = params;
  const target = fullText.length > 0 ? fullText : state.target;
  // A new target that doesn't extend the previous one means the source
  // restarted (e.g. next turn began before the prior drain finished) — rewind
  // the reveal counter so we don't skip past the new text.
  const revealed = target.startsWith(state.target) ? state.revealed : 0;
  const lag = Math.max(0, target.length - revealed);
  // Base rate covers small lag; larger lag drains within maxLagMs regardless.
  const rate = Math.max(baseRate, lag / (maxLagMs / 1000));
  const nextRevealed = Math.min(
    target.length,
    revealed + (deltaMs / 1000) * rate,
  );
  return { revealed: nextRevealed, target };
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Reveal `fullText` one character at a time at a steady rate, with gentle
 * acceleration when the source races ahead. Respects `prefers-reduced-motion`
 * (returns the full text directly, no caret).
 */
export function useTypewriter(
  fullText: string,
  isStreaming: boolean,
  opts?: UseTypewriterOptions,
): UseTypewriterResult {
  const baseRate = opts?.baseRate ?? TYPEWRITER_BASE_RATE;
  const maxLagMs = opts?.maxLagMs ?? TYPEWRITER_MAX_LAG_MS;
  const enabled = opts?.enabled ?? true;

  const [reducedMotion, setReducedMotion] = useState<boolean>(
    prefersReducedMotion,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", listener);
    return () => mq.removeEventListener?.("change", listener);
  }, []);

  const [displayedState, setDisplayed] = useState<string>("");
  const [showCaretState, setShowCaret] = useState<boolean>(false);

  const stateRef = useRef<TypewriterState>({ revealed: 0, target: "" });
  const fullTextRef = useRef(fullText);
  const isStreamingRef = useRef(isStreaming);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  const enabledRef = useRef(enabled);

  // Keep refs in sync with the latest props so the RAF loop (which reads refs,
  // not captured values) always sees the current fullText/isStreaming.
  useEffect(() => {
    fullTextRef.current = fullText;
    isStreamingRef.current = isStreaming;
  });

  useEffect(() => {
    if (enabled && !enabledRef.current) {
      const snapTo = fullTextRef.current;
      stateRef.current = { revealed: snapTo.length, target: snapTo };
      setDisplayed(snapTo);
      setShowCaret(isStreamingRef.current);
    }
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (reducedMotion || !enabled) return;
    const tick = (now: number) => {
      const last = lastTimeRef.current;
      const deltaMs = last === null ? 0 : now - last;
      lastTimeRef.current = now;

      stateRef.current = computeNextState({
        state: stateRef.current,
        fullText: fullTextRef.current,
        deltaMs,
        baseRate,
        maxLagMs,
      });

      // Advance math every frame; commit React state every other frame to keep
      // markdown re-parse cost down.
      frameCountRef.current += 1;
      const floor = Math.floor(stateRef.current.revealed);
      if (frameCountRef.current % 2 === 0) {
        setDisplayed(stateRef.current.target.slice(0, floor));
      }

      const drained = floor >= stateRef.current.target.length;
      setShowCaret(isStreamingRef.current || !drained);

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastTimeRef.current = null;
    };
  }, [reducedMotion, baseRate, maxLagMs, enabled]);

  if (reducedMotion) {
    return { displayed: fullText, showCaret: false };
  }
  if (!enabled) {
    return { displayed: fullText, showCaret: false };
  }
  if (!enabledRef.current) {
    return { displayed: fullText, showCaret: isStreaming };
  }
  return { displayed: displayedState, showCaret: showCaretState };
}
