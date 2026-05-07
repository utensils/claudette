import { memo, useCallback, useEffect, useRef, type RefObject, type MouseEvent } from "react";
import styles from "./ResizeHandle.module.css";

interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  /** Legacy per-pixel callback (used when cssVar is not provided). */
  onResize?: (delta: number) => void;
  /** DOM element whose CSS variable to mutate during drag. */
  targetRef?: RefObject<HTMLElement | null>;
  /** CSS custom property name to write (e.g. "--sidebar-w"). */
  cssVar?: string;
  min?: number;
  max?: number;
  /** Subtract delta instead of adding (right sidebar, terminal). */
  invert?: boolean;
  /** Called once on mouseup with the final pixel value. */
  onResizeEnd?: (finalValue: number) => void;
}

export const ResizeHandle = memo(function ResizeHandle({
  direction,
  onResize,
  targetRef,
  cssVar,
  min = 0,
  max = Infinity,
  invert = false,
  onResizeEnd,
}: ResizeHandleProps) {
  const isDraggingRef = useRef(false);
  const startPosRef = useRef(0);
  const startValueRef = useRef(0);
  const currentValueRef = useRef(0);
  const pendingValueRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const flushPendingValue = useCallback(() => {
    frameRef.current = null;
    const next = pendingValueRef.current;
    if (next === null || !targetRef?.current || !cssVar) return;
    targetRef.current.style.setProperty(cssVar, `${next}px`);
  }, [targetRef, cssVar]);

  const handleMouseDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;
    // Cache the CSS variable value once on mousedown to avoid getComputedStyle per pixel.
    if (targetRef?.current && cssVar) {
      currentValueRef.current = parseFloat(
        getComputedStyle(targetRef.current).getPropertyValue(cssVar),
      ) || 0;
      startValueRef.current = currentValueRef.current;
      pendingValueRef.current = currentValueRef.current;
      targetRef.current.dataset.resizing = "true";
    }
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [direction, targetRef, cssVar]);

  useEffect(() => {
    const cleanupTarget = targetRef?.current ?? null;

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (!isDraggingRef.current) return;

      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = currentPos - startPosRef.current;

      // CSS variable fast-path: write directly to the DOM, no React state.
      if (targetRef?.current && cssVar) {
        const next = Math.max(
          min,
          Math.min(max, startValueRef.current + (invert ? -delta : delta)),
        );
        currentValueRef.current = next;
        pendingValueRef.current = next;
        if (frameRef.current === null) {
          frameRef.current = window.requestAnimationFrame(flushPendingValue);
        }
        return;
      }

      // Legacy fallback: per-pixel React state callback.
      onResize?.(delta);
      startPosRef.current = currentPos;
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (targetRef?.current) {
        delete targetRef.current.dataset.resizing;
      }
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        flushPendingValue();
      }

      // Sync final value to React state once.
      if (targetRef?.current && cssVar && onResizeEnd) {
        onResizeEnd(currentValueRef.current);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (cleanupTarget) {
        delete cleanupTarget.dataset.resizing;
      }
    };
  }, [
    direction,
    onResize,
    targetRef,
    cssVar,
    min,
    max,
    invert,
    onResizeEnd,
    flushPendingValue,
  ]);

  return (
    <div
      className={`${styles.handle} ${direction === "horizontal" ? styles.horizontal : styles.vertical}`}
      onMouseDown={handleMouseDown}
    />
  );
});
