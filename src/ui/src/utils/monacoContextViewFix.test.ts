import { describe, expect, it } from "vitest";
import {
  correctContextViewPosition,
  type PositionTarget,
} from "./monacoContextViewFix";

// vitest runs in node — no DOM. The position correction is a pure
// transform on a `{ style: { left, top } }` shape, so we test it directly
// against a stub. End-to-end MutationObserver coverage lives in manual
// QA against the running app: see the verification steps in the PR
// description.
//
// The runtime feedback-loop guard is *not* in this pure function —
// codex's review pointed out that an equality-based echo guard can
// false-skip a real Monaco reposition (raw 200/100 at zoom 2 looks
// identical to the post-correction of raw 400/200). The guard now lives
// at the observer layer: each per-host MutationObserver is disconnected
// around our write, so the loop is structurally impossible. That's
// covered by manual QA, not these tests.

function makeTarget(left: string, top: string): PositionTarget {
  return { style: { left, top } };
}

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

  it("re-corrects unconditionally when called twice — no false skip", () => {
    // The pathological case codex flagged: at zoom 2, a previous correction
    // of raw 400/200 → 200/100 used to make the guard skip a *new* Monaco
    // reposition that happens to write raw 200/100. With no value-equality
    // guard in this layer, both calls correct.
    const el = makeTarget("400px", "200px");
    correctContextViewPosition(el, 2);
    expect(parseFloat(el.style.left)).toBeCloseTo(200, 6);
    // Monaco-driven reposition to raw 200/100. The pure function corrects
    // it to 100/50; the runtime observer-disconnect-around-write strategy
    // ensures the recursive write-from-write is impossible at the call
    // site. (Without that, the function would still correct here — the
    // bug under the old guard was the *skip*, not the recursion.)
    el.style.left = "200px";
    el.style.top = "100px";
    correctContextViewPosition(el, 2);
    expect(parseFloat(el.style.left)).toBeCloseTo(100, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(50, 6);
  });

  it("handles non-integer zoom factors without drift", () => {
    const el = makeTarget("500px", "250px");
    correctContextViewPosition(el, 1.25);
    expect(parseFloat(el.style.left)).toBeCloseTo(400, 6);
    expect(parseFloat(el.style.top)).toBeCloseTo(200, 6);
  });
});
