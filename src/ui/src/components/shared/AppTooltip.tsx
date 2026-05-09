import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { viewportLayoutSize, viewportToFixed } from "../../utils/zoom";
import styles from "./AppTooltip.module.css";

type TooltipPlacement = "top" | "bottom";

interface TooltipState {
  element: HTMLElement;
  text: string;
  placement: TooltipPlacement;
  rect: DOMRect;
}

interface TooltipPosition {
  left: number;
  top: number;
}

export interface TooltipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readTooltipElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>("[data-tooltip]");
  const text = el?.dataset.tooltip?.trim();
  return text ? el : null;
}

function readPlacement(el: HTMLElement): TooltipPlacement {
  return el.dataset.tooltipPlacement === "bottom" ? "bottom" : "top";
}

function toFixedRect(rect: DOMRect): TooltipRect {
  const topLeft = viewportToFixed(rect.left, rect.top);
  const bottomRight = viewportToFixed(rect.right, rect.bottom);
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

export function calculateTooltipPosition({
  anchorRect,
  tooltipRect,
  viewport,
  placement,
}: {
  anchorRect: TooltipRect;
  tooltipRect: Pick<TooltipRect, "width" | "height">;
  viewport: { width: number; height: number };
  placement: TooltipPlacement;
}): TooltipPosition {
  const { width, height } = tooltipRect;
  const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
  const maxLeft = viewport.width - width - VIEWPORT_MARGIN;
  const left = clamp(centeredLeft, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft));

  const preferredTop =
    placement === "bottom"
      ? anchorRect.bottom + TOOLTIP_GAP
      : anchorRect.top - height - TOOLTIP_GAP;
  const alternateTop =
    placement === "bottom"
      ? anchorRect.top - height - TOOLTIP_GAP
      : anchorRect.bottom + TOOLTIP_GAP;
  const fitsPreferred =
    preferredTop >= VIEWPORT_MARGIN &&
    preferredTop + height <= viewport.height - VIEWPORT_MARGIN;
  const unclampedTop = fitsPreferred ? preferredTop : alternateTop;
  const maxTop = viewport.height - height - VIEWPORT_MARGIN;
  const top = clamp(unclampedTop, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop));

  return { left, top };
}

export function AppTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);

  const clearTooltip = useCallback(() => {
    activeElementRef.current = null;
    setTooltip(null);
    setPosition(null);
  }, []);

  const showTooltip = useCallback((el: HTMLElement) => {
    const text = el.dataset.tooltip?.trim();
    if (!text) {
      clearTooltip();
      return;
    }

    // Elements using the app tooltip should not also trigger the browser's
    // native title tooltip, which appears later and duplicates the label.
    if (el.hasAttribute("title")) el.removeAttribute("title");

    activeElementRef.current = el;
    setPosition(null);
    setTooltip({
      element: el,
      text,
      placement: readPlacement(el),
      rect: el.getBoundingClientRect(),
    });
  }, [clearTooltip]);

  const refreshTooltip = useCallback(() => {
    const el = activeElementRef.current;
    if (!el || !document.body.contains(el)) {
      clearTooltip();
      return;
    }
    const text = el.dataset.tooltip?.trim();
    if (!text) {
      clearTooltip();
      return;
    }
    setTooltip({
      element: el,
      text,
      placement: readPlacement(el),
      rect: el.getBoundingClientRect(),
    });
  }, [clearTooltip]);

  useEffect(() => {
    const handlePointerOver = (ev: PointerEvent) => {
      const el = readTooltipElement(ev.target);
      if (!el || el === activeElementRef.current) return;
      showTooltip(el);
    };

    const handlePointerOut = (ev: PointerEvent) => {
      const active = activeElementRef.current;
      if (!active) return;
      const next = ev.relatedTarget;
      if (next instanceof Node && active.contains(next)) return;
      clearTooltip();
    };

    const handleFocusIn = (ev: FocusEvent) => {
      const el = readTooltipElement(ev.target);
      if (el) showTooltip(el);
    };

    const handleFocusOut = (ev: FocusEvent) => {
      const active = activeElementRef.current;
      if (!active) return;
      const next = ev.relatedTarget;
      if (next instanceof Node && active.contains(next)) return;
      clearTooltip();
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    window.addEventListener("scroll", refreshTooltip, true);
    window.addEventListener("resize", refreshTooltip);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      window.removeEventListener("scroll", refreshTooltip, true);
      window.removeEventListener("resize", refreshTooltip);
    };
  }, [clearTooltip, refreshTooltip, showTooltip]);

  useLayoutEffect(() => {
    if (!tooltip) return;
    const node = tooltipRef.current;
    if (!node) return;

    const anchorRect = toFixedRect(tooltip.rect);
    const tooltipRect = toFixedRect(node.getBoundingClientRect());
    setPosition(
      calculateTooltipPosition({
        anchorRect,
        tooltipRect,
        viewport: viewportLayoutSize(),
        placement: tooltip.placement,
      }),
    );
  }, [tooltip]);

  if (!tooltip || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className={styles.tooltip}
      role="tooltip"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        opacity: position ? 1 : 0,
      }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
