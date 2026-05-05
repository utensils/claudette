import { createPortal } from "react-dom";
import { viewportToFixed } from "../../utils/zoom";
import type { DragGhostState } from "../../hooks/useTabDragReorder";
import styles from "./TabDragGhost.module.css";

// Floating clone of a tab pinned to the cursor. Generic across surfaces
// (terminal tabs, workspace tabs, sidebar workspaces) — callers pass in a
// className to override the resting visuals to match their tab.
//
// Why portal + position: fixed: the ghost has to escape every container
// overflow + transform context (sidebar scrollbox, tab strip overflow, etc.)
// or it would clip mid-drag. We translate event coords (visual pixels under
// html zoom) to layout pixels via viewportToFixed so the ghost sits exactly
// where the cursor is regardless of UI font-scaling.

interface Props {
  ghost: DragGhostState;
  className?: string;
}

export function TabDragGhost({ ghost, className }: Props) {
  if (typeof document === "undefined") return null;
  const top = viewportToFixed(0, ghost.cursorY - ghost.offsetY).y;
  const left = viewportToFixed(ghost.cursorX - ghost.offsetX, 0).x;
  return createPortal(
    <div
      className={`${styles.ghost} ${className ?? ""}`}
      style={{ left, top, width: ghost.width, height: ghost.height }}
      aria-hidden
    >
      <span className={styles.title}>{ghost.title}</span>
    </div>,
    document.body,
  );
}
