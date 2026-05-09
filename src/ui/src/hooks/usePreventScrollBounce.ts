import { useEffect, type RefObject } from "react";

// The boundary-detection helpers below are exported so the test suite
// (`usePreventScrollBounce.test.ts`) can pin their behavior directly.
// They're pure (no DOM mutation, no side effects) and small enough that
// testing them in isolation is faster + more readable than reaching
// through the React hook lifecycle. The hook itself just composes these
// with capture-phase document listeners.

export function canScrollVertically(el: HTMLElement) {
  return el.scrollHeight > el.clientHeight + 1;
}

function allowsVerticalScrolling(el: HTMLElement) {
  const { overflowY } = window.getComputedStyle(el);
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

export function canScrollInDirection(el: HTMLElement, deltaY: number) {
  if (!canScrollVertically(el)) return false;
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) {
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  return false;
}

export function nearestScrollableWithin(
  target: EventTarget | null,
  boundary: HTMLElement,
) {
  if (!(target instanceof Element)) return boundary;

  let el: Element | null = target;
  while (el && el !== boundary) {
    if (
      el instanceof HTMLElement &&
      canScrollVertically(el) &&
      allowsVerticalScrolling(el)
    ) {
      return el;
    }
    el = el.parentElement;
  }

  return boundary;
}

function maxScrollTop(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}

function clampScrollTop(el: HTMLElement) {
  const max = maxScrollTop(el);
  if (el.scrollTop < 0) {
    el.scrollTop = 0;
  } else if (el.scrollTop > max) {
    el.scrollTop = max;
  }
}

function shouldHandleEvent(
  eventTarget: EventTarget | null,
  boundary: HTMLElement,
): eventTarget is Node {
  return eventTarget instanceof Node && boundary.contains(eventTarget);
}

export function boundaryScrollTarget(
  eventTarget: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
) {
  if (deltaY === 0 || !shouldHandleEvent(eventTarget, boundary)) return null;

  const activeScroller = nearestScrollableWithin(eventTarget, boundary);
  if (canScrollInDirection(activeScroller, deltaY)) return null;
  if (activeScroller !== boundary && canScrollInDirection(boundary, deltaY)) {
    return null;
  }

  return activeScroller;
}

function blockBoundaryScroll(event: Event, scrollTarget: HTMLElement) {
  clampScrollTop(scrollTarget);
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  requestAnimationFrame(() => clampScrollTop(scrollTarget));
}

/**
 * Prevents WebKit's elastic overscroll on desktop webviews. CSS
 * `overscroll-behavior` is not reliable enough in macOS WKWebView, so this
 * cancels wheel/touch gestures only when the active scroll surface is already
 * at the top or bottom edge.
 */
export function usePreventScrollBounce(
  containerRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const document = el.ownerDocument;

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const scrollTarget = boundaryScrollTarget(event.target, el, event.deltaY);
      if (!scrollTarget) return;
      blockBoundaryScroll(event, scrollTarget);
    };

    let lastTouchY: number | null = null;
    let touchTarget: EventTarget | null = null;

    const onTouchStart = (event: TouchEvent) => {
      if (!shouldHandleEvent(event.target, el)) {
        lastTouchY = null;
        touchTarget = null;
        return;
      }
      lastTouchY = event.touches[0]?.clientY ?? null;
      touchTarget = event.target;
    };

    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? null;
      if (lastTouchY == null || currentY == null) return;

      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;

      const scrollTarget = boundaryScrollTarget(touchTarget, el, deltaY);
      if (!scrollTarget) return;
      blockBoundaryScroll(event, scrollTarget);
    };

    const onScroll = () => {
      clampScrollTop(el);
    };

    const options: AddEventListenerOptions = { capture: true, passive: false };
    document.addEventListener("wheel", onWheel, options);
    document.addEventListener("touchstart", onTouchStart, options);
    document.addEventListener("touchmove", onTouchMove, options);
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      document.removeEventListener("wheel", onWheel, options);
      document.removeEventListener("touchstart", onTouchStart, options);
      document.removeEventListener("touchmove", onTouchMove, options);
      el.removeEventListener("scroll", onScroll);
    };
  }, [containerRef]);
}
