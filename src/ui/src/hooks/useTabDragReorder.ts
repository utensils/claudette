import {
  useState,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  reorderById,
  tabDropPlacement,
  type DragOrientation,
  type TabDropPlacement,
} from "../utils/dragReorder";

// Pointer-event drag-reorder primitive shared by all tab-style strips
// (terminal tabs, chat/file/diff workspace tabs, sidebar workspaces). The
// caller wires returned handlers onto each tab element + tags them with a
// `data-{dataAttr}-id` attribute so the hook can hit-test via
// elementFromPoint without a callback per tab. See `dragReorder.ts` for the
// pure reorder math and the WebKit-zoom rationale.

export interface DragGhostState {
  cursorX: number;
  cursorY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  title: string;
}

export interface DropTarget<Id> {
  id: Id;
  placement: TabDropPlacement;
}

interface UseTabDragReorderOptions<T, Id> {
  /**
   * The HTML data-* attribute (without the `data-` prefix) used to mark
   * draggable tabs in the DOM. e.g. `"terminalTabId"` for terminal tabs;
   * elements should have `data-terminal-tab-id="<id>"`. Used by the hook's
   * pointer-move handler to identify the tab under the cursor.
   */
  dataAttr: string;

  /**
   * Parse the raw data-* string back into an Id. (DOM data-* is always a
   * string; numeric ids need `Number(...)`, string ids pass through.)
   */
  parseId: (raw: string) => Id;

  /** Extract the unique id from an item. */
  getId: (item: T) => Id;

  /** Display title for the floating drag ghost. */
  getTitle: (item: T) => string;

  /**
   * Optional same-group predicate. Returns true if `dragged` and `target`
   * are valid neighbours (same repo, same kind, etc.). When it returns
   * false, the drop indicator is suppressed and the drop is rejected on
   * release. Defaults to "always allowed".
   */
  isSameGroup?: (dragged: T, target: T) => boolean;

  /**
   * Called on a successful drop. Receives the reordered list. The caller
   * applies it to local state and persists via the appropriate Tauri
   * command. If null is returned by `reorderById` the callback is NOT
   * invoked.
   */
  onReorder: (next: T[], draggedId: Id) => void;

  /**
   * Pixel hysteresis squared (default 16, i.e. 4px). Movement below this
   * is treated as a click — tab selection still works.
   */
  thresholdSquared?: number;

  /**
   * Axis along which items are arranged. "horizontal" (default) compares
   * cursor x against tab left/width — correct for tab strips. "vertical"
   * compares cursor y against tab top/height — correct for stacked lists
   * like the sidebar workspace list, where the last item can only be
   * dropped "after" by hovering its lower half (not its right half).
   */
  orientation?: DragOrientation;

  /** Items currently rendered, in display order. */
  items: readonly T[];
}

export interface UseTabDragReorderResult<T, Id> {
  /** Spread these onto each draggable tab element. */
  getTabHandlers: (item: T) => {
    onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (ev: ReactPointerEvent<HTMLElement>) => void;
  };
  /** Id of the tab currently being dragged, or null. */
  draggingId: Id | null;
  /** The hovered drop target (id + placement), or null. */
  dropTarget: DropTarget<Id> | null;
  /** Geometry for rendering a floating ghost; null when not dragging. */
  dragGhost: DragGhostState | null;
  /**
   * True for ~one frame after a drag ends, to suppress the synthetic
   * click that follows pointerup. Tab onClick handlers should early-return
   * when this is true.
   */
  justEnded: () => boolean;
}

export function useTabDragReorder<T, Id>(
  opts: UseTabDragReorderOptions<T, Id>,
): UseTabDragReorderResult<T, Id> {
  const {
    dataAttr,
    parseId,
    getId,
    getTitle,
    isSameGroup,
    onReorder,
    thresholdSquared = 16,
    orientation = "horizontal",
    items,
  } = opts;

  // dragRef + justEndedRef are pure mutable scratch state — they're only
  // written from inside event handlers (never during render), so they don't
  // run afoul of the React Compiler's "no-mutate-during-render" lint.
  const dragRef = useRef<{
    id: Id;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    title: string;
    active: boolean;
  } | null>(null);
  const justEndedRef = useRef(false);

  const [draggingId, setDraggingId] = useState<Id | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget<Id> | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState | null>(null);

  const dataKebab = camelToKebab(dataAttr);
  const dataSelector = `[data-${dataKebab}]`;

  // Handlers close over the latest items / isSameGroup / onReorder via
  // their lexical scope on each render — there's no memoization here.
  // Re-binding pointer handlers per render is cheap (closure allocation),
  // and importantly avoids stale closures when the items list changes
  // between drags.
  const finishDrag = (cancelled: boolean, hover: DropTarget<Id> | null) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    setDragGhost(null);
    if (!drag) return;
    if (!drag.active) return; // pure click — let onClick handle activation
    justEndedRef.current = true;
    queueMicrotask(() => {
      justEndedRef.current = false;
    });
    if (cancelled || !hover) return;
    if (Object.is(hover.id, drag.id)) return;
    const next = reorderById(items, drag.id, hover.id, hover.placement, getId);
    if (!next) return;
    onReorder(next, drag.id);
  };

  const getTabHandlers = (item: T) => {
    const itemId = getId(item);
    return {
      onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => {
        if (ev.button !== 0) return;
        // Don't initiate drag from buttons/inputs inside the tab.
        const t = ev.target as HTMLElement;
        if (t.closest("button, a, input, select, textarea")) return;
        // Stop the browser from starting a text selection from the
        // pointer-down before our setPointerCapture takes over. Belt-and-
        // braces with the tab CSS's `user-select: none` — necessary on
        // WebKit (macOS) where descendant `<span>`s can still resolve to
        // `-webkit-user-select: text` if any cascading rule says so.
        ev.preventDefault();
        const rect = ev.currentTarget.getBoundingClientRect();
        dragRef.current = {
          id: itemId,
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startY: ev.clientY,
          offsetX: ev.clientX - rect.left,
          offsetY: ev.clientY - rect.top,
          width: rect.width,
          height: rect.height,
          title: getTitle(item),
          active: false,
        };
        try {
          ev.currentTarget.setPointerCapture(ev.pointerId);
        } catch {
          // Already released — abandon.
          dragRef.current = null;
        }
      },
      onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== ev.pointerId) return;
        if (!drag.active) {
          const dx = ev.clientX - drag.startX;
          const dy = ev.clientY - drag.startY;
          if (dx * dx + dy * dy < thresholdSquared) return;
          drag.active = true;
          setDraggingId(drag.id);
          window.getSelection()?.removeAllRanges();
        }
        // Once the drag is active, every pointer-move suppresses the
        // browser's default scroll-on-drag and any lingering text-selection
        // gesture (mirrors the existing repo-drag in Sidebar.tsx).
        ev.preventDefault();
        setDragGhost({
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          offsetX: drag.offsetX,
          offsetY: drag.offsetY,
          width: drag.width,
          height: drag.height,
          title: drag.title,
        });

        const overEl = document.elementFromPoint(ev.clientX, ev.clientY);
        const tabEl = overEl?.closest<HTMLElement>(dataSelector) ?? null;
        const raw = tabEl?.getAttribute(`data-${dataKebab}`);
        if (!tabEl || raw == null) {
          setDropTarget((prev) => (prev === null ? prev : null));
          return;
        }
        const overId = parseId(raw);
        if (Object.is(overId, drag.id)) {
          setDropTarget((prev) => (prev === null ? prev : null));
          return;
        }
        // Cross-group rejection: when the caller declares a same-group
        // predicate and the dragged/target pair fails it, suppress the
        // drop indicator. The drag still tracks the cursor (the ghost
        // keeps following the pointer); we just refuse to commit.
        if (isSameGroup) {
          const draggedItem = items.find((i) =>
            Object.is(getId(i), drag.id),
          );
          const targetItem = items.find((i) => Object.is(getId(i), overId));
          if (
            !draggedItem ||
            !targetItem ||
            !isSameGroup(draggedItem, targetItem)
          ) {
            setDropTarget((prev) => (prev === null ? prev : null));
            return;
          }
        }
        const r = tabEl.getBoundingClientRect();
        const placement =
          orientation === "vertical"
            ? tabDropPlacement(ev.clientY, r.top, r.height)
            : tabDropPlacement(ev.clientX, r.left, r.width);
        setDropTarget((prev) =>
          prev &&
          Object.is(prev.id, overId) &&
          prev.placement === placement
            ? prev
            : { id: overId, placement },
        );
      },
      onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== ev.pointerId) return;
        try {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        } catch {
          // Already released.
        }
        finishDrag(false, dropTarget);
      },
      onPointerCancel: (ev: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== ev.pointerId) return;
        try {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        } catch {
          // Already released.
        }
        finishDrag(true, dropTarget);
      },
    };
  };

  return {
    getTabHandlers,
    draggingId,
    dropTarget,
    dragGhost,
    justEnded: () => justEndedRef.current,
  };
}

function camelToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
