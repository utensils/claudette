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
 * messages grow scrollHeight without firing scroll events). The hook
 * runs `update()` from each.
 */
export function OverlayScrollbar({ targetRef }: OverlayScrollbarProps) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
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
    const scrollProgress = scrollTop / (scrollHeight - clientHeight);
    const top = Math.round(scrollProgress * maxTop);
    setSliderHeight(height);
    setSliderTop(top);
  }, [targetRef]);

  // Scroll + size + content observation. Reruns `update()` on each.
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    update();
    const onScroll = () => update();
    target.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => update());
    ro.observe(target);
    const mo = new MutationObserver(() => update());
    mo.observe(target, { childList: true, subtree: true, characterData: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
    };
  }, [targetRef, update]);

  // Pointer-driven drag. Captures the pointer on the slider and maps
  // pixel deltas back to scrollTop deltas via the inverse of the
  // viewport / content ratio.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = targetRef.current;
      const slider = sliderRef.current;
      if (!target || !slider) return;
      e.preventDefault();
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

  return (
    <div
      className={styles.track}
      data-overflowing={overflowing ? "true" : "false"}
      aria-hidden="true"
    >
      <div
        ref={sliderRef}
        className={styles.slider}
        data-dragging={dragging ? "true" : "false"}
        onPointerDown={onPointerDown}
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
