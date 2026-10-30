import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { tooltipWithHotkey } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import styles from "./SessionTabs.module.css";

export type NavDirection = "prev" | "next" | "first" | "last";

// Drag-reorder slice of props each sub-tab consumes. Built once per render
// by SessionTabs.dragPropsFor; passed straight through to the tab element.
export interface TabDragProps {
  navKey: string;
  handlers: {
    onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (ev: ReactPointerEvent<HTMLElement>) => void;
  };
  isDragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  /** Reads the latest "did a drag just end" flag from the hook. Tab onClick
   *  handlers call this to skip the synthetic post-pointerup click. */
  isClickSuppressed: () => boolean;
}

/** Props every concrete tab kind (session / diff / file) forwards to the shell. */
export interface TabShellBaseProps {
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onNavigate: (direction: NavDirection) => void;
  onContextMenu: (x: number, y: number) => void;
  tabRef: (el: HTMLDivElement | null) => void;
  drag: TabDragProps | null;
}

interface TabShellProps extends TabShellBaseProps {
  /** Translated close-button label; also the tooltip base text. */
  closeLabel: string;
  /** True while the tab is inline-editing (rename). Suppresses select-on-click,
   *  the custom context menu, and tab keyboard handling so the input's own
   *  behavior wins. */
  locked?: boolean;
  /** When true, drag handlers are detached while `locked` (file tabs, so a
   *  text selection drag in the rename input doesn't start a tab drag). */
  detachDragWhileLocked?: boolean;
  /** F2 handler (session tabs start inline rename). */
  onRenameKey?: () => void;
  onDoubleClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/**
 * Shared chrome for one tab in the workspace tab strip: role/aria/tabIndex,
 * click + keyboard selection, arrow/Home/End navigation, right-click menu,
 * pointer drag-reorder wiring, drop-edge markers, and the close button.
 * The kind-specific icon + label are passed as `children`.
 */
export function TabShell({
  isActive,
  onSelect,
  onClose,
  onNavigate,
  onContextMenu,
  tabRef,
  drag,
  closeLabel,
  locked = false,
  detachDragWhileLocked = false,
  onRenameKey,
  onDoubleClick,
  children,
}: TabShellProps) {
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const closeTitle = isActive
    ? tooltipWithHotkey(closeLabel, "global.close-tab", keybindings, isMac)
    : closeLabel;
  const dragHandlers =
    detachDragWhileLocked && locked ? undefined : drag?.handlers;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (locked) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    } else if (e.key === "F2" && onRenameKey) {
      e.preventDefault();
      onRenameKey();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNavigate("prev");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNavigate("next");
    } else if (e.key === "Home") {
      e.preventDefault();
      onNavigate("first");
    } else if (e.key === "End") {
      e.preventDefault();
      onNavigate("last");
    }
  };

  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-session-tab-key={drag?.navKey}
      className={`${styles.tab} ${isActive ? styles.active : ""} ${drag?.isDragging ? styles.dragging : ""}`}
      onClick={() => {
        if (drag?.isClickSuppressed()) return;
        if (locked) return;
        onSelect();
      }}
      onContextMenu={(e) => {
        // Skip while inline-renaming so the input's native context menu
        // (cut/copy/paste) still works.
        if (locked) return;
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDoubleClick={onDoubleClick}
      onPointerDown={dragHandlers?.onPointerDown}
      onPointerMove={dragHandlers?.onPointerMove}
      onPointerUp={dragHandlers?.onPointerUp}
      onPointerCancel={dragHandlers?.onPointerCancel}
      onKeyDown={handleKeyDown}
    >
      {drag?.dropBefore && (
        <span className={`${styles.dropEdge} ${styles.dropBefore}`} aria-hidden />
      )}
      {drag?.dropAfter && (
        <span className={`${styles.dropEdge} ${styles.dropAfter}`} aria-hidden />
      )}
      {children}
      <button
        type="button"
        className={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        data-tooltip={closeTitle}
        data-tooltip-placement="bottom"
        aria-label={closeLabel}
      >
        <X size={12} />
      </button>
    </div>
  );
}
