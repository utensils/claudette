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
  // Flag to distinguish programmatic scrolls (our auto-scroll) from user scrolls.
  // Prevents the feedback loop: programmatic scroll → scroll event → re-enable
  // follow → programmatic scroll again.
  const programmaticScrollRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => {
      // Ignore scroll events caused by our own programmatic scrolling.
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }

      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;

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
    programmaticScrollRef.current = true;
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
      if (el) {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [containerRef]);

  return { isAtBottom, scrollToBottom, handleContentChanged } as const;
}
