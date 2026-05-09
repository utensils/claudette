import { describe, expect, it } from "vitest";
import { calculateTooltipPosition, type TooltipRect } from "./AppTooltip";

const anchor = (rect: Partial<TooltipRect> = {}): TooltipRect => ({
  left: 100,
  top: 100,
  right: 140,
  bottom: 120,
  width: 40,
  height: 20,
  ...rect,
});

describe("calculateTooltipPosition", () => {
  it("centers a top tooltip above the anchor when it fits", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: anchor(),
        tooltipRect: { width: 80, height: 24 },
        viewport: { width: 400, height: 300 },
        placement: "top",
      }),
    ).toEqual({ left: 80, top: 68 });
  });

  it("uses the alternate placement when the preferred side would clip", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: anchor({ top: 12, bottom: 32 }),
        tooltipRect: { width: 80, height: 24 },
        viewport: { width: 400, height: 300 },
        placement: "top",
      }),
    ).toEqual({ left: 80, top: 40 });
  });

  it("clamps horizontally to the viewport margin", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: anchor({ left: 4, right: 44 }),
        tooltipRect: { width: 120, height: 24 },
        viewport: { width: 400, height: 300 },
        placement: "bottom",
      }),
    ).toEqual({ left: 8, top: 128 });
  });

  it("clamps vertically when neither side has enough room", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: anchor({ top: 20, bottom: 40 }),
        tooltipRect: { width: 80, height: 100 },
        viewport: { width: 400, height: 110 },
        placement: "top",
      }),
    ).toEqual({ left: 80, top: 8 });
  });

  it("uses layout-pixel viewport and rect inputs after zoom conversion", () => {
    expect(
      calculateTooltipPosition({
        anchorRect: anchor({ left: 200, right: 260, top: 180, bottom: 220, width: 60, height: 40 }),
        tooltipRect: { width: 100, height: 30 },
        viewport: { width: 640, height: 360 },
        placement: "bottom",
      }),
    ).toEqual({ left: 180, top: 228 });
  });
});
