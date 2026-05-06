import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useAppStore } from "../../stores/useAppStore";
import { viewportLayoutSize, viewportToFixed } from "../../utils/zoom";
import { clampMenuToViewport } from "./contextMenuUtils";
import styles from "./ContextMenu.module.css";

export type ContextMenuItem =
  | {
      type?: "item";
      label: string;
      onSelect: () => void | Promise<void>;
      icon?: ReactNode;
      disabled?: boolean;
      variant?: "default" | "danger";
      closeOnSelect?: boolean;
    }
  | { type: "separator" };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  dataTestId?: string;
}

function clampToViewport(x: number, y: number, width: number, height: number) {
  if (typeof window === "undefined") return { x, y };
  const fixed = viewportToFixed(x, y);
  const { width: vw, height: vh } = viewportLayoutSize();
  return clampMenuToViewport(fixed.x, fixed.y, width, height, vw, vh);
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  dataTestId,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(
    null,
  );
  const itemCount = items.filter((item) => item.type !== "separator").length;
  const separatorCount = items.length - itemCount;

  const estimated = useMemo(
    () => ({ width: 220, height: itemCount * 34 + separatorCount * 9 + 12 }),
    [itemCount, separatorCount],
  );
  const size = measured ?? estimated;
  const clamped = clampToViewport(x, y, size.width, size.height);

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMeasured((prev) => {
      const next = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (prev?.width === next.width && prev.height === next.height) return prev;
      return next;
    });
  }, [items]);

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
      data-testid={dataTestId}
      onPointerDown={(ev) => ev.stopPropagation()}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      {items.map((item, i) => {
        if (item.type === "separator") {
          return <div key={i} className={styles.separator} role="separator" />;
        }
        const disabled = item.disabled || pendingIndex !== null;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.variant === "danger" ? styles.danger : ""}`}
            disabled={disabled}
            onClick={async () => {
              if (disabled) return;
              try {
                setPendingIndex(i);
                await item.onSelect();
                if (item.closeOnSelect !== false) onClose();
              } catch (err) {
                console.error("Context menu action failed:", err);
                useAppStore
                  .getState()
                  .addToast(`Action failed: ${String(err)}`);
              } finally {
                setPendingIndex(null);
              }
            }}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return typeof document === "undefined"
    ? menu
    : createPortal(menu, document.body);
}
