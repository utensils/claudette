import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Sticky-scroll hook: auto-scrolls to bottom when user is at the bottom of a
 * scrollable container, but stops when the user scrolls up.
 *
 * Returns `isAtBottom` for rendering a "jump to bottom" indicator, plus
 * `scrollToBottom` and `handleContentChanged` helpers.
 */
export function useStickyScroll(
  containerRef: RefObject<HTMLElement | null>,
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
    const prevScrollTop = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    // Only set the programmatic flag if the scroll position actually changed,
    // otherwise no scroll event fires and the flag would stick, eating the
    // next genuine user scroll.
    if (el.scrollTop !== prevScrollTop) {
      programmaticScrollRef.current = true;
    }
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, [containerRef]);

  /**
   * Call when new content is added. Auto-scrolls only if the user is already
   * at the bottom. The check is inside the RAF callback so a user scroll that
   * fires between scheduling and execution correctly cancels the auto-scroll.
   */
  const handleContentChanged = useCallback(() => {
    requestAnimationFrame(() => {
      if (!isAtBottomRef.current) return;
      const el = containerRef.current;
      if (el) {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [containerRef]);

  return { isAtBottom, scrollToBottom, handleContentChanged } as const;
}
