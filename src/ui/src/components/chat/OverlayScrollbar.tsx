import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import styles from "./OverlayScrollbar.module.css";

interface OverlayScrollbarProps {
  /**
   * Ref to the element that actually scrolls (the one with
   * `overflow-y: auto/scroll`). The track + slider are rendered as a
   * sibling inside that element's positioned ancestor, not as children
   * of the scrolling element itself (children would scroll with content).
   */
  targetRef: RefObject<HTMLElement | null>;
}

/**
 * Custom DOM scrollbar that mirrors xterm.js's and Monaco's overlay
 * scrollbar pattern. Renders an always-pixel-sized track + slider div
 * pair, hides the host element's native scrollbar via CSS at the call
 * site, and drives `targetRef.current.scrollTop` from drag input.
 *
 * Why a custom component: macOS WKWebView keeps the OS overlay scrollbar
 * regardless of `::-webkit-scrollbar` styling when the system "Show
 * scroll bars" preference is "Automatic" / "When scrolling", and the
 * resulting overlay does NOT scale with browser zoom. xterm.js and
 * Monaco both draw their own DOM sliders for exactly this reason —
 * matching that approach is the only way the three surfaces stay in
 * pixel-for-pixel sync at every zoom level.
 *
 * Tracking model: a single `update()` reads scrollTop / scrollHeight /
 * clientHeight, computes slider top + height in CSS pixels, and pushes
 * to a small state object. We listen to (a) scroll events on the target
 * (b) a ResizeObserver on the target itself (window resize + flex
 * reflows) (c) a MutationObserver for content additions (streaming
 * messages grow scrollHeight without firing scroll events). Every entry
 * point routes through the same RAF-coalesced `scheduleUpdate()` so
 * fast streaming (one MutationObserver fire per token) collapses to one
 * setState batch per frame instead of one per mutation.
 *
 * Accessibility note: the slider is intentionally not focusable. Native
 * macOS scrollbars aren't focusable either; the underlying scroll
 * element remains keyboard-scrollable (PageUp/Down/arrows when focused)
 * because `scrollbar-width: none` only hides the visual scrollbar, it
 * doesn't disable keyboard scrolling. Track click-to-page is handled
 * explicitly below to preserve the behavior the native scrollbar gave
 * us before the swap.
 */
export function OverlayScrollbar({ targetRef }: OverlayScrollbarProps) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const rafPendingRef = useRef(false);
  const [overflowing, setOverflowing] = useState(false);
  const [sliderTop, setSliderTop] = useState(0);
  const [sliderHeight, setSliderHeight] = useState(0);
  const [dragging, setDragging] = useState(false);

  const update = useCallback(() => {
    const target = targetRef.current;
    if (!target) return;
    const { scrollTop, scrollHeight, clientHeight } = target;
    const overflow = scrollHeight > clientHeight + 1;
    setOverflowing(overflow);
    if (!overflow) {
      setSliderHeight(0);
      setSliderTop(0);
      return;
    }
    // Slider height proportional to viewport / content ratio, with a
    // floor so a very long thread still shows a draggable handle.
    const minHeight = 24;
    const rawHeight = (clientHeight / scrollHeight) * clientHeight;
    const height = Math.max(minHeight, rawHeight);
    const maxTop = clientHeight - height;
    // `scrollHeight - clientHeight > 0` is guaranteed by the `overflow`
    // gate above — the divide-by-zero branch never executes here.
    const scrollProgress = scrollTop / (scrollHeight - clientHeight);
    const top = Math.round(scrollProgress * maxTop);
    setSliderHeight(height);
    setSliderTop(top);
  }, [targetRef]);

  /**
   * RAF gate copied from `useStickyScroll` (`hooks/useStickyScroll.ts`).
   * Streaming agent replies fire one MutationObserver per token; without
   * this, every token would trigger up to three setState calls and a
   * reconciliation. With it, mutations within a frame collapse to a
   * single update. `useStickyScroll` already coalesces its own work the
   * same way — keeping the two in step avoids one observing the chat
   * "stuck" while the other catches up.
   */
  const scheduleUpdate = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      update();
    });
  }, [update]);

  // Scroll + size + content observation. Reruns the coalesced update on
  // each. The initial `update()` is synchronous so the first paint
  // already reflects current scrollHeight (otherwise the slider flashes
  // missing for one frame on every mount).
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    update();
    target.addEventListener("scroll", scheduleUpdate, { passive: true });
    const ro = new ResizeObserver(scheduleUpdate);
    ro.observe(target);
    const mo = new MutationObserver(scheduleUpdate);
    mo.observe(target, { childList: true, subtree: true, characterData: true });
    return () => {
      target.removeEventListener("scroll", scheduleUpdate);
      ro.disconnect();
      mo.disconnect();
    };
  }, [targetRef, update, scheduleUpdate]);

  // Pointer-driven drag on the slider itself. Captures the pointer on
  // the slider and maps pixel deltas back to scrollTop deltas via the
  // inverse of the viewport / content ratio.
  const onSliderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = targetRef.current;
      const slider = sliderRef.current;
      if (!target || !slider) return;
      // Stop propagation so the track's click-to-page handler doesn't
      // also fire on the same pointerdown.
      e.preventDefault();
      e.stopPropagation();
      slider.setPointerCapture(e.pointerId);
      setDragging(true);
      const startY = e.clientY;
      const startScrollTop = target.scrollTop;
      const { scrollHeight, clientHeight } = target;
      const trackHeight = clientHeight;
      const sliderH = slider.offsetHeight;
      const usableTrack = trackHeight - sliderH;
      const scrollRange = scrollHeight - clientHeight;
      // Map every pixel of slider travel to (scrollRange / usableTrack)
      // pixels of scroll travel. Clamp so dragging past the rail end
      // doesn't push scrollTop outside its valid range.
      const scale = usableTrack > 0 ? scrollRange / usableTrack : 0;
      const onMove = (ev: PointerEvent) => {
        const delta = (ev.clientY - startY) * scale;
        const next = Math.max(
          0,
          Math.min(scrollRange, startScrollTop + delta),
        );
        target.scrollTop = next;
      };
      const onUp = (ev: PointerEvent) => {
        slider.releasePointerCapture(ev.pointerId);
        slider.removeEventListener("pointermove", onMove);
        slider.removeEventListener("pointerup", onUp);
        slider.removeEventListener("pointercancel", onUp);
        setDragging(false);
      };
      slider.addEventListener("pointermove", onMove);
      slider.addEventListener("pointerup", onUp);
      slider.addEventListener("pointercancel", onUp);
    },
    [targetRef],
  );

  // Track click-to-page. Native macOS scrollbar (and Monaco's slider)
  // both jump by a viewport-height when the user clicks the track above
  // or below the slider. xterm.js doesn't, but parity with native +
  // Monaco is the more user-visible behavior, so we restore it. The
  // track only intercepts pointer events while the data attribute says
  // overflowing — see CSS — so on short conversations clicks pass
  // through to message content underneath.
  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Only act when the click landed on the track itself, not on the
      // slider child (the slider has its own onPointerDown).
      if (e.target !== e.currentTarget) return;
      const target = targetRef.current;
      const slider = sliderRef.current;
      if (!target || !slider) return;
      e.preventDefault();
      const sliderRect = slider.getBoundingClientRect();
      // Page up if click is above the slider's top edge, down if below
      // its bottom edge. A click directly on the slider hits the slider
      // handler instead, so we don't need a tie-breaker here.
      const direction = e.clientY < sliderRect.top ? -1 : 1;
      const next = Math.max(
        0,
        Math.min(
          target.scrollHeight - target.clientHeight,
          target.scrollTop + direction * target.clientHeight,
        ),
      );
      target.scrollTop = next;
    },
    [targetRef],
  );

  return (
    <div
      className={styles.track}
      data-overflowing={overflowing ? "true" : "false"}
      aria-hidden="true"
      onPointerDown={onTrackPointerDown}
    >
      <div
        ref={sliderRef}
        className={styles.slider}
        data-dragging={dragging ? "true" : "false"}
        onPointerDown={onSliderPointerDown}
        style={{
          transform: `translateY(${sliderTop}px)`,
          height: `${sliderHeight}px`,
          // Hide cleanly when there's no overflow; CSS hides the track
          // too but `display: none` on the slider stops it from being
          // briefly hit-testable during the fade.
          display: overflowing ? "block" : "none",
        }}
      />
    </div>
  );
}
