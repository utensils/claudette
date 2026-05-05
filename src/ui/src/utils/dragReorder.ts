// Generic drag-reorder helpers shared across the terminal tab bar, the
// chat/file/diff workspace tab strip, and the sidebar workspace list.
//
// Why hand-rolled instead of HTML5 DnD: WebKit-on-macOS does not deliver
// `dragover`/`drop` events under the html `zoom` we apply for UI font scaling,
// so all of Claudette's drag interactions are pointer-event based. These
// helpers are the bits of logic that aren't tied to a specific React
// component — pure functions over an items list and a hovered tab geometry.

export type TabDropPlacement = "before" | "after";

/**
 * Decide whether the cursor is over the left or right half of a tab.
 * Pure geometry — `clientX` and `tabLeft` must be in the same coordinate
 * space (typically pointer-event clientX and DOMRect.left).
 */
export function tabDropPlacement(
  clientX: number,
  tabLeft: number,
  tabWidth: number,
): TabDropPlacement {
  return clientX < tabLeft + tabWidth / 2 ? "before" : "after";
}

/**
 * Reorder an items array so `dragged` lands `placement` of `target`.
 * Returns a new array, or `null` if the move is a no-op or invalid.
 *
 * Generic over any item identifier — the caller supplies a `getId` accessor.
 * Does NOT stamp any `sort_order` field on items; persistence shape is the
 * caller's concern. (Terminal tabs, sessions, workspaces all keep their
 * `sort_order` column derived from array index by their respective Tauri
 * commands — they don't need a stamped value in the local state.)
 */
export function reorderById<T, Id>(
  items: readonly T[],
  draggedId: Id,
  targetId: Id,
  placement: TabDropPlacement,
  getId: (item: T) => Id,
): T[] | null {
  if (Object.is(draggedId, targetId)) return null;
  const fromIndex = items.findIndex((item) => Object.is(getId(item), draggedId));
  const targetIndex = items.findIndex((item) => Object.is(getId(item), targetId));
  if (fromIndex < 0 || targetIndex < 0) return null;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  // After splicing the dragged item out, the target's index may have shifted.
  const adjustedTargetIndex = next.findIndex((item) =>
    Object.is(getId(item), targetId),
  );
  if (adjustedTargetIndex < 0) return null;
  const insertAt =
    placement === "before" ? adjustedTargetIndex : adjustedTargetIndex + 1;
  next.splice(insertAt, 0, moved);
  return next;
}
