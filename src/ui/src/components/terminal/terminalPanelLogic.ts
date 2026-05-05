import type { TerminalTab } from "../../types/terminal";

export type TabDropPlacement = "before" | "after";

export function tabDropPlacement(
  clientX: number,
  tabLeft: number,
  tabWidth: number,
): TabDropPlacement {
  return clientX < tabLeft + tabWidth / 2 ? "before" : "after";
}

export function reorderTerminalTabs(
  tabs: readonly TerminalTab[],
  draggedTabId: number,
  targetTabId: number,
  placement: TabDropPlacement,
): TerminalTab[] | null {
  if (draggedTabId === targetTabId) return null;
  const fromIndex = tabs.findIndex((tab) => tab.id === draggedTabId);
  const targetExists = tabs.some((tab) => tab.id === targetTabId);
  if (fromIndex < 0 || !targetExists) return null;

  const reordered = [...tabs];
  const [moved] = reordered.splice(fromIndex, 1);
  const toIndex = reordered.findIndex((tab) => tab.id === targetTabId);
  if (fromIndex < 0 || toIndex < 0) return null;

  reordered.splice(placement === "before" ? toIndex : toIndex + 1, 0, moved);
  return reordered.map((tab, index) => ({ ...tab, sort_order: index }));
}

export function clampTerminalContextMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
) {
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}
