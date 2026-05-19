import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

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
      shortcut?: string;
      disabled?: boolean;
      variant?: "default" | "danger";
      closeOnSelect?: boolean;
    }
  | { type: "separator" }
  | {
      type: "submenu";
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      children: ContextMenuItem[];
    }
  /// Non-interactive section label. Used by long submenus (e.g. the
  /// "Send to new workspace" model picker) to label groups so the
  /// reader can tell Claude Code curated entries from Pi-discovered
  /// sub-provider blocks. Skipped by hover/keyboard navigation.
  | { type: "header"; label: string };

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

// Place the submenu so it stays visually attached to its parent item:
//
//   - Try to open to the right of the parent item. If that would overflow
//     the viewport, flip to the LEFT of the parent menu so the two boxes
//     still touch.
//   - Anchor the submenu's top at the parent item's top (with a 4px nudge
//     for chevron alignment). Don't let `clampMenuToViewport` pull the
//     top up to the viewport edge — that's what produces the "menu floats
//     at top of window" disconnect when the model list is taller than
//     viewport. Instead set an explicit `maxHeight` equal to the space
//     between the anchor and the bottom margin, so the submenu scrolls
//     internally rather than detaching.
function computeSubmenuLayout(
  anchor: { x: number; y: number; parentLeft: number },
  size: { width: number; height: number },
) {
  if (typeof window === "undefined") {
    return { x: anchor.x, y: anchor.y, maxHeight: size.height };
  }
  const margin = 8;
  const { width: vw, height: vh } = viewportLayoutSize();
  // Horizontal: prefer right, fall back to flipping left of the parent menu.
  let x = anchor.x;
  if (x + size.width > vw - margin) {
    const flipped = anchor.parentLeft - size.width;
    x = flipped >= margin ? flipped : Math.max(margin, vw - size.width - margin);
  }
  if (x < margin) x = margin;
  // Vertical: top at anchor.y, cap height to remaining viewport. If the
  // anchor itself is below the bottom margin (shouldn't happen, but
  // defensively), pull it up.
  const y = Math.max(margin, Math.min(anchor.y, vh - margin - 100));
  const maxHeight = Math.max(120, vh - y - margin);
  return { x, y, maxHeight };
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  dataTestId,
}: ContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mountedRef = useRef(true);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [openSubmenu, setOpenSubmenu] = useState<{
    index: number;
    x: number;
    y: number;
    parentLeft: number;
  } | null>(null);
  const [submenuMeasured, setSubmenuMeasured] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const itemCount = items.filter((item) => item.type !== "separator").length;
  const separatorCount = items.length - itemCount;

  const estimated = useMemo(
    () => ({ width: 220, height: itemCount * 34 + separatorCount * 9 + 12 }),
    [itemCount, separatorCount],
  );
  const size = measured ?? estimated;
  const clamped = clampToViewport(x, y, size.width, size.height);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  useLayoutEffect(() => {
    if (!openSubmenu) {
      setSubmenuMeasured(null);
      return;
    }
    const rect = submenuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSubmenuMeasured((prev) => {
      const next = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (prev?.width === next.width && prev.height === next.height) return prev;
      return next;
    });
  }, [openSubmenu]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (openSubmenu) {
          setOpenSubmenu(null);
        } else {
          onClose();
        }
      }
    }
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      // Container ref wraps BOTH the parent menu and any open submenu, so a
      // single contains() check keeps the submenu open when the user clicks
      // inside it.
      if (containerRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onOutside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onOutside, true);
    };
  }, [onClose, openSubmenu]);

  const openSubmenuFor = useCallback((index: number) => {
    const btn = itemRefs.current[index];
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // Anchor the submenu at the parent item's top-right corner. Vertical
    // adjustment (-4px) lines the first submenu item up with its parent
    // chevron when both menus use 4px padding. We also stash the parent
    // menu's left edge so the submenu can flip leftward when the right
    // side would overflow.
    const parentMenuRect = menuRef.current?.getBoundingClientRect();
    setOpenSubmenu({
      index,
      x: rect.right,
      y: rect.top - 4,
      parentLeft: parentMenuRect?.left ?? rect.left,
    });
  }, []);

  const submenuItem =
    openSubmenu !== null && items[openSubmenu.index]?.type === "submenu"
      ? (items[openSubmenu.index] as Extract<ContextMenuItem, { type: "submenu" }>)
      : null;

  // Position the submenu without the y-shift that `clampMenuToViewport`
  // would otherwise apply. The clamp's behaviour is fine for a primary
  // context menu (it pulls a tall menu away from the bottom edge), but
  // for a submenu it visually detaches the popup from its parent item —
  // the user sees a 1000px gap between "Send to new workspace" and the
  // model list. Instead, keep the submenu's top anchored to the parent
  // item's top and cap its max-height so it scrolls internally when it
  // can't fit downward.
  const submenuSize = submenuMeasured ?? { width: 240, height: 200 };
  const submenuLayout = openSubmenu
    ? computeSubmenuLayout(openSubmenu, submenuSize)
    : null;

  const handleItemActivate = async (
    item: Extract<ContextMenuItem, { type?: "item" }>,
    index: number,
  ) => {
    if (item.disabled || pendingIndex !== null) return;
    try {
      setPendingIndex(index);
      await item.onSelect();
      if (item.closeOnSelect !== false) onClose();
    } catch (err) {
      console.error("Context menu action failed:", err);
      useAppStore.getState().addToast(`Action failed: ${String(err)}`);
    } finally {
      if (mountedRef.current) {
        setPendingIndex(null);
      }
    }
  };

  const renderItems = (
    list: ContextMenuItem[],
    options: {
      isSubmenu: boolean;
      onItemEnter?: (index: number, item: ContextMenuItem) => void;
      assignRef?: (index: number, el: HTMLButtonElement | null) => void;
    },
  ) => {
    return list.map((item, i) => {
      if (item.type === "separator") {
        return <div key={i} className={styles.separator} role="separator" />;
      }
      if (item.type === "header") {
        return (
          <div
            key={i}
            className={styles.header}
            role="presentation"
            aria-hidden="true"
          >
            {item.label}
          </div>
        );
      }
      if (item.type === "submenu") {
        const submenuOpen =
          !options.isSubmenu && openSubmenu?.index === i;
        return (
          <button
            key={i}
            ref={(el) => options.assignRef?.(i, el)}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={submenuOpen}
            className={`${styles.item} ${submenuOpen ? styles.itemActive : ""}`}
            disabled={item.disabled}
            onMouseEnter={() => options.onItemEnter?.(i, item)}
            onFocus={() => options.onItemEnter?.(i, item)}
            onClick={() => {
              if (item.disabled) return;
              if (!options.isSubmenu) openSubmenuFor(i);
            }}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            <span className={styles.label}>{item.label}</span>
            <ChevronRight
              size={12}
              className={styles.submenuChevron}
              aria-hidden="true"
            />
          </button>
        );
      }
      const disabled = item.disabled || pendingIndex !== null;
      return (
        <button
          key={i}
          ref={(el) => options.assignRef?.(i, el)}
          type="button"
          role="menuitem"
          title={item.label}
          className={`${styles.item} ${item.variant === "danger" ? styles.danger : ""}`}
          disabled={disabled}
          onMouseEnter={() => options.onItemEnter?.(i, item)}
          onFocus={() => options.onItemEnter?.(i, item)}
          onClick={() => void handleItemActivate(item, i)}
        >
          {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
          <span className={styles.label}>{item.label}</span>
          {item.shortcut ? (
            <span className={styles.shortcut} aria-hidden="true">
              {item.shortcut}
            </span>
          ) : null}
        </button>
      );
    });
  };

  const tree = (
    <div ref={containerRef} className={styles.menuContainer}>
      <div
        ref={menuRef}
        className={styles.menu}
        style={{ left: clamped.x, top: clamped.y }}
        role="menu"
        data-testid={dataTestId}
        onPointerDown={(ev) => ev.stopPropagation()}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        {renderItems(items, {
          isSubmenu: false,
          assignRef: (i, el) => {
            itemRefs.current[i] = el;
          },
          onItemEnter: (i, item) => {
            if (item.type === "submenu") {
              if (item.disabled) return;
              openSubmenuFor(i);
            } else {
              // Hovering a non-submenu item closes whatever submenu is open
              // so the user can navigate the parent without lingering popups.
              setOpenSubmenu(null);
            }
          },
        })}
      </div>
      {submenuItem && openSubmenu && submenuLayout && (
        <div
          ref={submenuRef}
          className={styles.menu}
          style={{
            left: submenuLayout.x,
            top: submenuLayout.y,
            maxHeight: submenuLayout.maxHeight,
          }}
          role="menu"
          onPointerDown={(ev) => ev.stopPropagation()}
          onMouseDown={(ev) => ev.stopPropagation()}
        >
          {renderItems(submenuItem.children, {
            isSubmenu: true,
            onItemEnter: () => {
              // Keep submenu open while the cursor is inside it; no-op.
            },
          })}
        </div>
      )}
    </div>
  );

  return typeof document === "undefined"
    ? tree
    : createPortal(tree, document.body);
}
