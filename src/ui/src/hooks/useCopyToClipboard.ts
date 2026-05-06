import { useCallback, useEffect, useRef, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";

/** A copy source: a literal string, or a (sync/async) thunk that resolves
 *  one. Returning `null` from the thunk signals "intentionally invalid"
 *  (e.g. binary/truncated/missing) — the hook flips to `error` state
 *  without invoking `onError`, matching the existing silent-fail UX. */
export type CopySource =
  | string
  | (() => string | null | Promise<string | null>);

export type CopyState = "idle" | "copied" | "error";

export interface UseCopyToClipboardOptions {
  resetMs?: number;
  onError?: (err: unknown) => void;
}

export interface UseCopyToClipboardResult {
  state: CopyState;
  copied: boolean;
  copy: (source: CopySource) => Promise<boolean>;
  reset: () => void;
}

const DEFAULT_RESET_MS = 1500;

/** Resolve a copy source to its final string. Returns `null` to signal a
 *  silent invalid result (empty string treated the same — copying nothing
 *  is never useful). Thunks that throw bubble up so the caller can route
 *  them to `onError`. Pure so it can be unit-tested. */
export async function resolveCopySource(
  source: CopySource,
): Promise<string | null> {
  const resolved = typeof source === "function" ? await source() : source;
  if (resolved == null || resolved === "") return null;
  return resolved;
}

export function useCopyToClipboard(
  options: UseCopyToClipboardOptions = {},
): UseCopyToClipboardResult {
  const { resetMs = DEFAULT_RESET_MS, onError } = options;
  const [state, setState] = useState<CopyState>("idle");
  const resetRef = useRef<number | null>(null);
  // Latest `onError` without re-creating `copy` on every render — callers
  // commonly pass an inline closure, and we don't want each render to
  // invalidate `useCallback` dependents downstream (e.g. memoized JSX).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const clearTimer = useCallback(() => {
    if (resetRef.current !== null) {
      window.clearTimeout(resetRef.current);
      resetRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setState("idle");
  }, [clearTimer]);

  const scheduleReset = useCallback(
    (next: CopyState) => {
      clearTimer();
      setState(next);
      resetRef.current = window.setTimeout(() => {
        resetRef.current = null;
        setState("idle");
      }, resetMs);
    },
    [clearTimer, resetMs],
  );

  const copy = useCallback(
    async (source: CopySource): Promise<boolean> => {
      let text: string | null;
      try {
        text = await resolveCopySource(source);
      } catch (err) {
        onErrorRef.current?.(err);
        scheduleReset("error");
        return false;
      }
      if (text === null) {
        scheduleReset("error");
        return false;
      }
      try {
        await clipboardWriteText(text);
      } catch (err) {
        onErrorRef.current?.(err);
        scheduleReset("error");
        return false;
      }
      scheduleReset("copied");
      return true;
    },
    [scheduleReset],
  );

  return {
    state,
    copied: state === "copied",
    copy,
    reset,
  };
}
