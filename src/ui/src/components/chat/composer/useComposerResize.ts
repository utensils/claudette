import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";

export const COMPOSER_MIN_HEIGHT = 52;
const COMPOSER_DEFAULT_AUTOGROW_MAX = 160;
const COMPOSER_MAX_HEIGHT = 1200;

function clampComposerHeight(value: number, max: number): number {
  return Math.max(COMPOSER_MIN_HEIGHT, Math.min(max, value));
}

/**
 * User-resizable composer height. The persisted height lives in the store;
 * the CSS var `--composer-h` on the inputArea div drives the textarea's
 * visible height, and CSS keeps the historical 160px auto-grow ceiling until
 * the user resizes beyond it.
 */
export function useComposerResize(
  inputAreaRef: React.RefObject<HTMLDivElement | null>,
) {
  const composerHeight = useAppStore((s) => s.composerHeight);
  const setComposerHeight = useAppStore((s) => s.setComposerHeight);
  // Dynamic upper bound for the resize drag — half the chat pane's
  // height, so the user can't drag the composer past the visible
  // message area. Measured via ResizeObserver on the inputArea's
  // offsetParent (the chat session container).
  const [composerMaxBound, setComposerMaxBound] = useState(COMPOSER_DEFAULT_AUTOGROW_MAX);
  const appliedComposerHeight = Math.min(composerHeight, composerMaxBound);
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    const target = el.offsetParent as HTMLElement | null;
    if (!target) return;
    const update = () => {
      const half = Math.floor(target.clientHeight / 2);
      setComposerMaxBound(
        Math.max(
          COMPOSER_MIN_HEIGHT,
          Math.min(COMPOSER_MAX_HEIGHT, half),
        ),
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(target);
    return () => ro.disconnect();
  }, [inputAreaRef]);
  // Mirror Zustand value → CSS var on the inputArea. ResizeHandle
  // writes the var directly during drag (no React state churn); this
  // effect handles every other update (mount, persistence rehydrate,
  // external setComposerHeight calls).
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    if (el.dataset.resizing === "true") return;
    el.style.setProperty("--composer-h", `${appliedComposerHeight}px`);
  }, [appliedComposerHeight, inputAreaRef]);
  const handleComposerResizeEnd = useCallback(
    (final: number) => setComposerHeight(clampComposerHeight(final, composerMaxBound)),
    [composerMaxBound, setComposerHeight],
  );
  return { composerMaxBound, appliedComposerHeight, handleComposerResizeEnd };
}
