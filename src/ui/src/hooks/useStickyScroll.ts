import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sticky-scroll hook: auto-scrolls to bottom when user is at the bottom of a
 * scrollable container, but stops when the user scrolls up.
 *
 * Returns `isAtBottom` for rendering a "jump to bottom" indicator, plus
 * `scrollToBottom` and `handleContentChanged` helpers.
 */
export function useStickyScroll(
  containerRef: React.RefObject<HTMLElement | null>,
  threshold = 60,
) {
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const prevScrollHeightRef = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    prevScrollHeightRef.current = el.scrollHeight;

    const onScroll = () => {
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;

      // If content height changed (content added/removed during streaming or
      // turn finalization) while we were following, stay in follow mode.
      // Without this, unmounting the StreamingMessage shrinks scrollHeight,
      // the browser fires a scroll event, and we'd incorrectly flip to
      // "not at bottom" right before the new message renders.
      const scrollHeightChanged = el.scrollHeight !== prevScrollHeightRef.current;
      prevScrollHeightRef.current = el.scrollHeight;

      if (scrollHeightChanged && isAtBottomRef.current && !atBottom) {
        return;
      }

      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [containerRef, threshold]);

  /** Programmatically scroll to bottom and re-enable auto-follow. */
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, [containerRef]);

  /**
   * Call when new content is added. Auto-scrolls only if the user is already
   * at the bottom (reads the ref to avoid stale closures).
   */
  const handleContentChanged = useCallback(() => {
    if (!isAtBottomRef.current) return;
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [containerRef]);

  return { isAtBottom, scrollToBottom, handleContentChanged } as const;
}
