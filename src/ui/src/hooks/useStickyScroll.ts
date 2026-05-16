import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Sticky-scroll hook: auto-scrolls to bottom when user is at the bottom of a
 * scrollable container, but stops when the user scrolls up.
 *
 * Tracks position via scroll events, ResizeObserver (container resizes), and
 * MutationObserver (DOM changes like new messages, tool call expansion, and
 * streaming content updates).
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
  const programmaticScrollRef = useRef(false);
  const rafPendingRef = useRef(false);
  const userScrollVersionRef = useRef(0);
  const suppressNextAutoScrollRef = useRef(false);
  // Kept in a ref so the RAF callback always reads the latest value without
  // needing threshold in its useCallback deps (which would recreate the fn
  // and re-attach the MutationObserver on every threshold change).
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;

  /**
   * Auto-scroll to bottom if the user is already there.
   * Coalesced: at most one requestAnimationFrame callback per frame,
   * preventing stacked RAFs from racing during fast streaming.
   */
  const handleContentChanged = useCallback(() => {
    if (rafPendingRef.current) return;
    const shouldAutoScroll = isAtBottomRef.current;
    const userScrollVersion = userScrollVersionRef.current;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const suppress = suppressNextAutoScrollRef.current;
      suppressNextAutoScrollRef.current = false;
      if (suppress) {
        // Content grew but we intentionally skipped the auto-scroll (e.g. the
        // user expanded an inline diff preview). Recompute the actual scroll
        // position so the scroll-to-bottom pill and subsequent auto-scroll
        // decisions reflect reality — without this, isAtBottomRef stays `true`
        // and the very next DOM mutation (syntax-highlight re-render, etc.)
        // would unexpectedly jump to bottom.
        const el = containerRef.current;
        if (el) {
          const atBottom =
            el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdRef.current;
          if (atBottom !== isAtBottomRef.current) {
            isAtBottomRef.current = atBottom;
            setIsAtBottom(atBottom);
          }
        }
        return;
      }
      const userScrolledSinceSchedule =
        userScrollVersionRef.current !== userScrollVersion;
      if (
        (!shouldAutoScroll && !isAtBottomRef.current) ||
        (userScrolledSinceSchedule && !isAtBottomRef.current)
      ) {
        return;
      }
      const el = containerRef.current;
      if (el) {
        const prev = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        if (el.scrollTop !== prev) {
          programmaticScrollRef.current = true;
        }
        if (!isAtBottomRef.current) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
      }
    });
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const checkPosition = () => {
      const atBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    };

    const onScroll = () => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      checkPosition();
    };
    const noteUserScrollIntent = () => {
      userScrollVersionRef.current += 1;
    };

    // ResizeObserver: catches container resizes (panel toggle, window resize).
    // Scroll first if pinned to bottom — prevents checkPosition() from
    // flipping isAtBottomRef to false before auto-scroll can act on it.
    const resizeObserver = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
      checkPosition();
    });
    resizeObserver.observe(el);

    // MutationObserver: catches all DOM changes within the scroll container
    // (new messages, tool call expansion/collapse, streaming content).
    // This is critical — ResizeObserver only watches the container's border
    // box, which doesn't change when children grow inside a flex:1 container.
    const mutationObserver = new MutationObserver(() => handleContentChanged());
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Re-check on window focus (content may arrive while app is backgrounded).
    const onFocus = () => {
      checkPosition();
      handleContentChanged();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", noteUserScrollIntent, { passive: true });
    el.addEventListener("touchmove", noteUserScrollIntent, { passive: true });
    el.addEventListener("keydown", noteUserScrollIntent);
    window.addEventListener("focus", onFocus);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", noteUserScrollIntent);
      el.removeEventListener("touchmove", noteUserScrollIntent);
      el.removeEventListener("keydown", noteUserScrollIntent);
      window.removeEventListener("focus", onFocus);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, threshold, handleContentChanged]);

  /** Programmatically scroll to bottom and re-enable auto-follow. */
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    // Second pass after layout settles (React may flush a pending render).
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      programmaticScrollRef.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }, [containerRef]);

  /** Restore a saved scrollTop without re-enabling auto-follow. */
  const restoreScrollPosition = useCallback(
    (scrollTop: number) => {
      const el = containerRef.current;
      if (!el) return;
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const nextScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
      programmaticScrollRef.current = true;
      el.scrollTop = nextScrollTop;
      const atBottom =
        nextScrollTop + el.clientHeight >=
        el.scrollHeight - thresholdRef.current;
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    },
    [containerRef],
  );

  return {
    isAtBottom,
    scrollToBottom,
    restoreScrollPosition,
    handleContentChanged,
    suppressNextAutoScrollRef,
  } as const;
}
