// @vitest-environment happy-dom

// Regression suite for `usePreventScrollBounce`. The hook's job is to
// suppress macOS WebView's elastic overscroll on the chat messages
// container WITHOUT breaking scroll chaining — at the boundary of the
// container the gesture is cancelled, but if a nested scrollable widget
// (a code block, thinking-block diff, attachment preview) can still
// scroll in the same direction, the gesture is allowed through and
// chains naturally.
//
// The hook composes a small set of pure boundary-detection helpers
// (`canScrollVertically`, `canScrollInDirection`, `nearestScrollableWithin`,
// `boundaryScrollTarget`); we test those directly because their logic is
// the part that's easy to regress when someone tweaks the predicate. A
// final end-to-end test mounts the hook against a synthetic DOM, fires a
// wheel event, and asserts the predicates wire up correctly to actual
// `preventDefault()` behavior.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boundaryScrollTarget,
  canScrollInDirection,
  canScrollVertically,
  nearestScrollableWithin,
  usePreventScrollBounce,
} from "./usePreventScrollBounce";
import { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
  vi.restoreAllMocks();
});

/** Build an HTMLElement with stubbed layout properties so the helpers
 *  can read scrollTop / scrollHeight / clientHeight under happy-dom
 *  (which doesn't compute real layout). overflowY defaults to "auto"
 *  so the element is treated as scrollable; tests that need to check
 *  the overflow gate override it. */
function makeScrollable(metrics: {
  scrollTop?: number;
  scrollHeight: number;
  clientHeight: number;
  overflowY?: string;
}): HTMLElement {
  const el = document.createElement("div");
  // Apply via inline style so getComputedStyle().overflowY resolves.
  el.style.overflowY = metrics.overflowY ?? "auto";
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop ?? 0,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  document.body.appendChild(el);
  mountedContainers.push(el);
  return el;
}

describe("canScrollVertically", () => {
  it("returns true when scrollHeight exceeds clientHeight by more than 1px", () => {
    const el = makeScrollable({ scrollHeight: 200, clientHeight: 100 });
    expect(canScrollVertically(el)).toBe(true);
  });

  it("returns false when content fits exactly", () => {
    const el = makeScrollable({ scrollHeight: 100, clientHeight: 100 });
    expect(canScrollVertically(el)).toBe(false);
  });

  it("returns false at the +1px tolerance boundary (avoids subpixel false positives)", () => {
    // Float subpixel rounding sometimes leaves scrollHeight === clientHeight + 1
    // even when there's no real overflow; the tolerance prevents the hook
    // from treating those as scrollable surfaces.
    const el = makeScrollable({ scrollHeight: 101, clientHeight: 100 });
    expect(canScrollVertically(el)).toBe(false);
  });
});

describe("canScrollInDirection", () => {
  it("blocks upward scroll when already at the top", () => {
    const el = makeScrollable({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 100,
    });
    expect(canScrollInDirection(el, -10)).toBe(false);
  });

  it("allows upward scroll when not at the top", () => {
    const el = makeScrollable({
      scrollTop: 50,
      scrollHeight: 500,
      clientHeight: 100,
    });
    expect(canScrollInDirection(el, -10)).toBe(true);
  });

  it("blocks downward scroll when at the bottom", () => {
    const el = makeScrollable({
      scrollTop: 400,
      scrollHeight: 500,
      clientHeight: 100,
    });
    expect(canScrollInDirection(el, 10)).toBe(false);
  });

  it("allows downward scroll when not at the bottom", () => {
    const el = makeScrollable({
      scrollTop: 100,
      scrollHeight: 500,
      clientHeight: 100,
    });
    expect(canScrollInDirection(el, 10)).toBe(true);
  });

  it("returns false for non-scrollable elements regardless of delta", () => {
    const el = makeScrollable({ scrollHeight: 100, clientHeight: 100 });
    expect(canScrollInDirection(el, -10)).toBe(false);
    expect(canScrollInDirection(el, 10)).toBe(false);
  });

  it("returns false for a deltaY of 0 (no direction implied)", () => {
    const el = makeScrollable({
      scrollTop: 50,
      scrollHeight: 500,
      clientHeight: 100,
    });
    expect(canScrollInDirection(el, 0)).toBe(false);
  });
});

describe("nearestScrollableWithin", () => {
  it("walks up to the boundary and returns the first scrollable ancestor", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
    });
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
    });
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    boundary.appendChild(inner);
    expect(nearestScrollableWithin(leaf, boundary)).toBe(inner);
  });

  it("falls back to the boundary when no nested scrollable is found", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
    });
    const leaf = document.createElement("span");
    boundary.appendChild(leaf);
    expect(nearestScrollableWithin(leaf, boundary)).toBe(boundary);
  });

  it("ignores elements with overflowY visible/hidden even if they have overflow content", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
    });
    // overflowY: visible disqualifies — that element doesn't host its
    // own scroll surface even if its content overflows.
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
      overflowY: "visible",
    });
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    boundary.appendChild(inner);
    expect(nearestScrollableWithin(leaf, boundary)).toBe(boundary);
  });

  it("returns the boundary when target isn't an Element (e.g. document)", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
    });
    expect(nearestScrollableWithin(null, boundary)).toBe(boundary);
    // EventTarget that is not a Node (synthetic in some environments)
    // also falls through to the boundary.
    expect(nearestScrollableWithin({} as unknown as EventTarget, boundary)).toBe(
      boundary,
    );
  });
});

describe("boundaryScrollTarget", () => {
  it("returns null when delta is zero (no direction to evaluate)", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100,
    });
    expect(boundaryScrollTarget(boundary, boundary, 0)).toBeNull();
  });

  it("returns null when target is outside the boundary", () => {
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
    });
    const stranger = makeScrollable({
      scrollHeight: 100,
      clientHeight: 50,
    });
    expect(boundaryScrollTarget(stranger, boundary, 10)).toBeNull();
  });

  it("returns null (allows the gesture through) when the active scroller can chain", () => {
    // The chat panel is at scrollTop > 0 (mid-page); a nested code block
    // is also mid-scroll. Wheel down: the inner scroller can scroll
    // down, so we DON'T block — chaining is allowed.
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100,
    });
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 50,
    });
    boundary.appendChild(inner);
    expect(boundaryScrollTarget(inner, boundary, 10)).toBeNull();
  });

  it("returns the active scroller (blocks bounce) when neither active nor boundary can chain", () => {
    // The Codex P2 regression test: chat is pinned at the bottom AND
    // the inner code block is also at the bottom of its own scroll. A
    // wheel-down at this point would bounce the WebView; the hook
    // must block it.
    const boundary = makeScrollable({
      scrollHeight: 200,
      clientHeight: 200, // no overflow on the boundary
      scrollTop: 0,
    });
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400, // already at bottom
    });
    boundary.appendChild(inner);
    const result = boundaryScrollTarget(inner, boundary, 10);
    expect(result).toBe(inner);
  });

  it("falls back to the boundary scroller when the inner has no scroll, boundary is at the edge", () => {
    // Common case: pointer over inert message text in a chat that's
    // already scrolled to the bottom.
    const boundary = makeScrollable({
      scrollHeight: 500,
      clientHeight: 200,
      scrollTop: 300, // at bottom: 300 + 200 = 500
    });
    const leaf = document.createElement("span");
    boundary.appendChild(leaf);
    const result = boundaryScrollTarget(leaf, boundary, 10);
    expect(result).toBe(boundary);
  });

  it("allows chain when the boundary is mid-scroll even if the active scroller cannot chain", () => {
    // Inner code block is at its bottom but the chat itself can still
    // scroll down — the gesture should pass through to the chat.
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100, // mid-scroll
    });
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400, // at bottom
    });
    boundary.appendChild(inner);
    expect(boundaryScrollTarget(inner, boundary, 10)).toBeNull();
  });
});

describe("usePreventScrollBounce (end-to-end on a wheel event)", () => {
  /** Mount a tiny component that wires the hook to a ref over a
   *  pre-built boundary. Returns the boundary so the test can fire
   *  events against it. */
  async function mountHook(boundary: HTMLElement) {
    const root = createRoot(document.createElement("div"));
    mountedRoots.push(root);
    const Wrapper = () => {
      const ref = useRef<HTMLElement | null>(boundary);
      usePreventScrollBounce(ref);
      return null;
    };
    await act(async () => {
      root.render(<Wrapper />);
    });
  }

  it("calls preventDefault when the gesture would bounce off the boundary", async () => {
    const boundary = makeScrollable({
      scrollHeight: 200,
      clientHeight: 200, // no overflow
      scrollTop: 0,
    });
    await mountHook(boundary);
    const wheel = new WheelEvent("wheel", {
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    // Dispatch on the boundary itself so `event.target` is inside it.
    // The hook's listener is registered on `document` in capture phase
    // and fires regardless of where the event was dispatched.
    boundary.dispatchEvent(wheel);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("does NOT call preventDefault when a nested scroller can still chain", async () => {
    // Regression target for the global `* { overscroll-behavior: contain }`
    // removal — without this the nested scroller would lose its ability
    // to chain into the chat scroller.
    const boundary = makeScrollable({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100,
    });
    const inner = makeScrollable({
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 50, // mid-scroll, can chain in either direction
    });
    boundary.appendChild(inner);
    await mountHook(boundary);
    const wheel = new WheelEvent("wheel", {
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    // Dispatch on the inner scroller — `event.target` becomes `inner`,
    // and the boundary detection finds it as the active scroller.
    inner.dispatchEvent(wheel);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("ignores horizontal-dominant wheel deltas (don't fight horizontal trackpad scrolls)", async () => {
    const boundary = makeScrollable({
      scrollHeight: 200,
      clientHeight: 200,
    });
    await mountHook(boundary);
    const wheel = new WheelEvent("wheel", {
      deltaX: 50,
      deltaY: 5,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    boundary.dispatchEvent(wheel);
    // |deltaX (50)| > |deltaY (5)| → horizontal gesture, not our concern.
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
