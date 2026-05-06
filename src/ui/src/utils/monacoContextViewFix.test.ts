import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCorrectionMemoForTests,
  correctContextViewPosition,
  type PositionTarget,
} from "./monacoContextViewFix";

// vitest runs in node — no DOM. The position correction is a pure
// transform on a `{ style: { left, top } }` shape, so we test it directly
// against a stub. End-to-end MutationObserver coverage lives in manual
// QA against the running app: see the verification steps in the PR
// description.

function makeTarget(left: string, top: string): PositionTarget {
  return { style: { left, top } };
}

afterEach(() => {
  // Each test creates fresh targets, but defensive in case a future test
  // reuses an object reference across describe blocks.
});

describe("correctContextViewPosition", () => {
  it("divides left/top by zoom and writes them back", () => {
    const el = makeTarget("300px", "150px");
    const wrote = correctContextViewPosition(el, 1.5);
    expect(wrote).toBe(true);
    expect(parseFloat(el.style.left)).toBeCloseTo(200, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(100, 6);
  });

  it("skips when style.left is unparseable (Monaco hasn't mounted yet)", () => {
    const el = makeTarget("", "");
    expect(correctContextViewPosition(el, 1.5)).toBe(false);
    expect(el.style.left).toBe("");
    expect(el.style.top).toBe("");
  });

  it("skips the echo of our own write to break the observer feedback loop", () => {
    const el = makeTarget("400px", "200px");
    expect(correctContextViewPosition(el, 2)).toBe(true);
    // Echo: same values, no Monaco move. Should be a no-op.
    expect(correctContextViewPosition(el, 2)).toBe(false);
    expect(parseFloat(el.style.left)).toBeCloseTo(200, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(100, 6);
  });

  it("re-corrects when Monaco moves the menu to a new uncorrected position", () => {
    const el = makeTarget("500px", "250px");
    correctContextViewPosition(el, 1.25);
    expect(parseFloat(el.style.left)).toBeCloseTo(400, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(200, 6);
    // Monaco moves the menu (e.g. submenu expansion clamps it).
    el.style.left = "1000px";
    el.style.top = "500px";
    const wrote = correctContextViewPosition(el, 1.25);
    expect(wrote).toBe(true);
    expect(parseFloat(el.style.left)).toBeCloseTo(800, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(400, 6);
  });

  it("treats sub-pixel deltas (<0.5px) as echo", () => {
    // After we write 200/100, browser style serialization can round to
    // "200px"/"100px"; if Monaco then re-writes the *same logical* values,
    // the serialized string may differ by a sub-pixel amount. We accept
    // any delta < 0.5px as an echo so we don't oscillate.
    const el = makeTarget("400.2px", "200px");
    correctContextViewPosition(el, 2);
    el.style.left = "200.1px";
    el.style.top = "100px";
    expect(correctContextViewPosition(el, 2)).toBe(false);
  });

  it("forgets memo across distinct elements (per-target weak ref)", () => {
    const a = makeTarget("400px", "200px");
    const b = makeTarget("400px", "200px");
    correctContextViewPosition(a, 2);
    // `b` is a different object; its memo is empty so the same input is
    // corrected, not skipped.
    expect(correctContextViewPosition(b, 2)).toBe(true);
    expect(parseFloat(b.style.left)).toBeCloseTo(200, 6);
    __resetCorrectionMemoForTests(a);
    __resetCorrectionMemoForTests(b);
  });
});
