import { describe, it, expect } from "vitest";
import { clampMenuToViewport } from "./AttachmentContextMenu";

// The component itself is thin wiring around a few DOM listeners and a
// portal; its integration is verified manually in the running app. The
// clamp logic is pure and carries the interesting edge-case behavior, so
// we unit-test it in isolation — following the existing convention in
// focusTargets.test.ts of pure-logic-only tests rather than pulling in a
// DOM harness (jsdom / testing-library).
//
// The async "stay open while the action is in flight" behavior
// (AttachmentContextMenuItem.onSelect returning a Promise holds the menu
// open until it settles) is intentionally verified manually rather than
// with a jsdom render harness: copy a large image and paste into another
// app before the menu dismisses — the paste works because the menu only
// closes after the clipboard write has actually resolved.

describe("clampMenuToViewport", () => {
  it("passes through positions that already fit", () => {
    expect(clampMenuToViewport(100, 100, 220, 80, 1200, 800)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("pulls the menu left when the click is near the right edge", () => {
    const { x } = clampMenuToViewport(1190, 100, 220, 80, 1200, 800);
    // maxX = 1200 - 220 - 8 = 972
    expect(x).toBe(972);
  });

  it("pulls the menu up when the click is near the bottom edge", () => {
    const { y } = clampMenuToViewport(100, 790, 220, 80, 1200, 800);
    // maxY = 800 - 80 - 8 = 712
    expect(y).toBe(712);
  });

  it("enforces a minimum margin on the top-left corner", () => {
    expect(clampMenuToViewport(-10, -10, 220, 80, 1200, 800)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("honors a custom margin", () => {
    const { x } = clampMenuToViewport(5, 100, 220, 80, 1200, 800, 16);
    expect(x).toBe(16);
  });
});
