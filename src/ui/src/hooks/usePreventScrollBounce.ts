import { useEffect, type RefObject } from "react";

function canScrollVertically(el: HTMLElement) {
  return el.scrollHeight > el.clientHeight + 1;
}

function canScrollInDirection(el: HTMLElement, deltaY: number) {
  if (!canScrollVertically(el)) return false;
  if (deltaY < 0) return el.scrollTop > 0;
  if (deltaY > 0) {
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  return false;
}

function nearestScrollableWithin(
  target: EventTarget | null,
  boundary: HTMLElement,
) {
  if (!(target instanceof Element)) return boundary;

  let el: Element | null = target;
  while (el && el !== boundary) {
    if (el instanceof HTMLElement && canScrollVertically(el)) {
      return el;
    }
    el = el.parentElement;
  }

  return boundary;
}

function shouldBlockBoundaryScroll(
  eventTarget: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
) {
  if (deltaY === 0) return false;

  const activeScroller = nearestScrollableWithin(eventTarget, boundary);
  if (canScrollInDirection(activeScroller, deltaY)) return false;
  if (activeScroller !== boundary && canScrollInDirection(boundary, deltaY)) {
    return false;
  }

  return true;
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

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (!shouldBlockBoundaryScroll(event.target, el, event.deltaY)) return;
      if (event.cancelable) event.preventDefault();
    };

    let lastTouchY: number | null = null;
    let touchTarget: EventTarget | null = null;

    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
      touchTarget = event.target;
    };

    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? null;
      if (lastTouchY == null || currentY == null) return;

      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;

      if (!shouldBlockBoundaryScroll(touchTarget, el, deltaY)) return;
      if (event.cancelable) event.preventDefault();
    };

    const options: AddEventListenerOptions = { passive: false };
    el.addEventListener("wheel", onWheel, options);
    el.addEventListener("touchstart", onTouchStart, options);
    el.addEventListener("touchmove", onTouchMove, options);

    return () => {
      el.removeEventListener("wheel", onWheel, options);
      el.removeEventListener("touchstart", onTouchStart, options);
      el.removeEventListener("touchmove", onTouchMove, options);
    };
  }, [containerRef]);
}
