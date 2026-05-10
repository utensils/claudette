import type { MouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./PanelHeader.module.css";

export interface PanelHeaderProps {
  /** Title / breadcrumb area on the left. Rendered inside a non-selectable
   *  region whose blank space initiates a window drag — so a long workspace
   *  name or project path doesn't accidentally swallow the drag affordance.
   *  Anything interactive (buttons, links) inside `left` keeps working
   *  because the CSS marks descendants `app-region: no-drag`. */
  left: ReactNode;
  /** Right-side action slot (panel toggles, workspace menus, etc.).
   *  Marked `no-drag` so clicks reach the targets instead of the window. */
  right?: ReactNode;
}

/** Single panel-header chrome shared between the global Dashboard, the
 *  project-scoped view, and the per-workspace chat view. Centralizes:
 *
 *  - `data-tauri-drag-region` so the bar drags the OS window.
 *  - `user-select: none` + an explicit `startDragging()` mousedown handler
 *    on the left content. macOS / Tauri 2 webviews need both: the CSS
 *    blocks accidental text selection that would otherwise inhibit drag,
 *    and the JS handler ensures the drag actually starts even when the
 *    cursor lands on text rather than empty padding.
 *  - Mac-only padding shift when the sidebar is hidden so the traffic
 *    lights don't overlap the title.
 *
 *  Callers compose the visual content via `left` / `right` slots.
 */
export function PanelHeader({ left, right }: PanelHeaderProps) {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);

  const handleHeaderLabelMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch((err) => {
        console.error("Failed to start window drag from header label:", err);
      });
  };

  return (
    <div
      className={`${styles.header} ${!sidebarVisible ? styles.noSidebar : ""}`}
      data-tauri-drag-region
    >
      <div
        className={styles.headerLeft}
        onMouseDown={handleHeaderLabelMouseDown}
      >
        {left}
      </div>
      {right !== undefined && (
        <div className={styles.headerRight}>{right}</div>
      )}
    </div>
  );
}
