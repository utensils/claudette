import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import styles from "./AttachmentContextMenu.module.css";

export interface AttachmentContextMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}

interface AttachmentContextMenuProps {
  x: number;
  y: number;
  items: AttachmentContextMenuItem[];
  onClose: () => void;
}

// Keep the menu fully on-screen: if the click is close enough to the right or
// bottom edge, shift the anchor so the menu opens up/left instead of clipping.
// Exported for unit tests — the rendered component is thin enough that it
// gets manual QA coverage in the running app.
export function clampMenuToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
) {
  const maxX = viewportWidth - width - margin;
  const maxY = viewportHeight - height - margin;
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY)),
  };
}

function clampToViewport(x: number, y: number, width: number, height: number) {
  if (typeof window === "undefined") return { x, y };
  return clampMenuToViewport(
    x,
    y,
    width,
    height,
    window.innerWidth,
    window.innerHeight,
  );
}

export function AttachmentContextMenu({
  x,
  y,
  items,
  onClose,
}: AttachmentContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Measure once rendered so we can clamp. Rough fallback for the first frame.
  const estimated = useMemo(
    () => ({ width: 220, height: items.length * 34 + 12 }),
    [items.length],
  );
  const clamped = clampToViewport(x, y, estimated.width, estimated.height);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    function onOutside(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onOutside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onOutside, true);
    };
  }, [onClose]);

  const menu = (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: clamped.x, top: clamped.y }}
      role="menu"
      data-testid="attachment-context-menu"
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );

  // Portal to body so parent `overflow: hidden` containers (message list,
  // attachment strip) can't clip the menu.
  return typeof document === "undefined"
    ? menu
    : createPortal(menu, document.body);
}
