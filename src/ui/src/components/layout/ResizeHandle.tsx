import { useCallback, useEffect, useRef } from "react";
import styles from "./ResizeHandle.module.css";

interface ResizeHandleProps {
  direction: "horizontal" | "vertical";
  onResize: (delta: number) => void;
}

export function ResizeHandle({
  direction,
  onResize,
}: ResizeHandleProps) {
  const isDraggingRef = useRef(false);
  const startPosRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startPosRef.current = direction === "horizontal" ? e.clientX : e.clientY;
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [direction]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;

      const currentPos = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = currentPos - startPosRef.current;

      onResize(delta);
      startPosRef.current = currentPos;
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [direction, onResize]);

  return (
    <div
      className={`${styles.handle} ${direction === "horizontal" ? styles.horizontal : styles.vertical}`}
      onMouseDown={handleMouseDown}
    />
  );
}
