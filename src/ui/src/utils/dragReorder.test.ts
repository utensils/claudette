import { describe, expect, it } from "vitest";
import { reorderById, tabDropPlacement } from "./dragReorder";

describe("tabDropPlacement", () => {
  it("returns 'before' when cursor is left of midpoint", () => {
    expect(tabDropPlacement(124, 100, 50)).toBe("before");
  });
  it("returns 'after' when cursor is at or past midpoint", () => {
    expect(tabDropPlacement(125, 100, 50)).toBe("after");
    expect(tabDropPlacement(149, 100, 50)).toBe("after");
  });
});

describe("reorderById", () => {
  type Item = { id: number; name: string };
  const item = (id: number): Item => ({ id, name: `item-${id}` });
  const id = (i: Item) => i.id;

  it("moves a tab before its target", () => {
    const result = reorderById([item(1), item(2), item(3)], 3, 1, "before", id);
    expect(result?.map((i) => i.id)).toEqual([3, 1, 2]);
  });

  it("moves a tab after its target", () => {
    const result = reorderById([item(1), item(2), item(3)], 3, 1, "after", id);
    expect(result?.map((i) => i.id)).toEqual([1, 3, 2]);
  });

  it("forward drag adjusts for the post-splice target index", () => {
    const before = reorderById([item(1), item(2), item(3)], 1, 3, "before", id);
    const after = reorderById([item(1), item(2), item(3)], 1, 3, "after", id);
    expect(before?.map((i) => i.id)).toEqual([2, 1, 3]);
    expect(after?.map((i) => i.id)).toEqual([2, 3, 1]);
  });

  it("returns null for self-drops, missing dragged, or missing target", () => {
    expect(reorderById([item(1), item(2)], 1, 1, "before", id)).toBeNull();
    expect(reorderById([item(1), item(2)], 9, 1, "before", id)).toBeNull();
    expect(reorderById([item(1), item(2)], 1, 9, "before", id)).toBeNull();
  });

  it("works with string ids", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }] as const;
    const result = reorderById(items, "c", "a", "before", (i) => i.id);
    expect(result?.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });
});
