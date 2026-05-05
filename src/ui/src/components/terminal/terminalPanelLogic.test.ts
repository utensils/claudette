import { describe, expect, it } from "vitest";
import type { TerminalTab } from "../../types/terminal";
import {
  reorderTerminalTabs,
  tabDropPlacement,
} from "./terminalPanelLogic";

function tab(id: number, sortOrder = id): TerminalTab {
  return {
    id,
    workspace_id: "workspace-a",
    title: `Terminal ${id}`,
    is_script_output: false,
    sort_order: sortOrder,
    created_at: "",
  };
}

describe("reorderTerminalTabs", () => {
  it("moves the dragged tab before the dropped-on tab and rewrites sort order", () => {
    const reordered = reorderTerminalTabs([tab(1), tab(2), tab(3)], 3, 1, "before");

    expect(reordered?.map((t) => t.id)).toEqual([3, 1, 2]);
    expect(reordered?.map((t) => t.sort_order)).toEqual([0, 1, 2]);
  });

  it("moves the dragged tab after the dropped-on tab", () => {
    const reordered = reorderTerminalTabs([tab(1), tab(2), tab(3)], 3, 1, "after");

    expect(reordered?.map((t) => t.id)).toEqual([1, 3, 2]);
    expect(reordered?.map((t) => t.sort_order)).toEqual([0, 1, 2]);
  });

  it("supports moving a tab to the right before or after the target", () => {
    const beforeTarget = reorderTerminalTabs([tab(1), tab(2), tab(3)], 1, 3, "before");
    const afterTarget = reorderTerminalTabs([tab(1), tab(2), tab(3)], 1, 3, "after");

    expect(beforeTarget?.map((t) => t.id)).toEqual([2, 1, 3]);
    expect(afterTarget?.map((t) => t.id)).toEqual([2, 3, 1]);
    expect(afterTarget?.map((t) => t.sort_order)).toEqual([0, 1, 2]);
  });

  it("keeps adjacent rightward after-target drops stable", () => {
    const reordered = reorderTerminalTabs([tab(1), tab(2), tab(3)], 1, 2, "after");

    expect(reordered?.map((t) => t.id)).toEqual([2, 1, 3]);
    expect(reordered?.map((t) => t.sort_order)).toEqual([0, 1, 2]);
  });

  it("returns null for no-op or invalid drags", () => {
    expect(reorderTerminalTabs([tab(1), tab(2)], 1, 1, "before")).toBeNull();
    expect(reorderTerminalTabs([tab(1), tab(2)], 9, 1, "before")).toBeNull();
    expect(reorderTerminalTabs([tab(1), tab(2)], 1, 9, "before")).toBeNull();
  });
});

describe("tabDropPlacement", () => {
  it("uses the target tab midpoint to choose before or after", () => {
    expect(tabDropPlacement(124, 100, 50)).toBe("before");
    expect(tabDropPlacement(125, 100, 50)).toBe("after");
    expect(tabDropPlacement(149, 100, 50)).toBe("after");
  });
});
