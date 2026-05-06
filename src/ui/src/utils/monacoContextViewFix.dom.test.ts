/**
 * Integration tests for the Monaco `.context-view` positioning patch. These
 * exercise the real MutationObserver wiring under happy-dom — what the
 * pure-function tests in monacoContextViewFix.test.ts deliberately don't
 * cover.
 *
 * Why this file exists: the first pass of this fix shipped a refactor
 * (disconnect-around-write + per-host observer dedup) that the pure-math
 * tests passed but that visibly broke the menu in the running app. The
 * gap was that no test exercised the actual Monaco-side flow — element
 * appended → observer fires → correction applied → potential re-write
 * from observer feedback. Adding these tests is how we keep that gap
 * closed.
 */

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCoordSpaceCache } from "./zoom";
import {
  __resetMonacoContextViewFixForTests,
  installMonacoContextViewFix,
} from "./monacoContextViewFix";

// The engine probe in zoom.ts decides whether we divide by zoom by placing
// a hidden 100px-wide marker and reading back its rect. happy-dom's layout
// engine doesn't actually compute `style.left = 100px` into a non-zero
// rect, so we patch `getBoundingClientRect` on the probe element to
// simulate the chosen engine.
function stubProbe(engine: "webkit" | "chromium", zoom: number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (
    this: HTMLElement,
  ): DOMRect {
    const looksLikeProbe =
      this.style.position === "fixed" &&
      this.style.left === "100px" &&
      this.style.width === "100px" &&
      this.style.visibility === "hidden";
    if (looksLikeProbe) {
      const left = engine === "webkit" ? 100 * zoom : 100;
      return new DOMRect(left, 0, 100, 1);
    }
    return new DOMRect(0, 0, 0, 0);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function setRootZoom(z: number | null): void {
  if (z === null) document.documentElement.style.removeProperty("zoom");
  else document.documentElement.style.zoom = String(z);
}

// Append a `.context-view` to body with its position pre-set, mimicking
// Monaco's pattern: the style is set synchronously, then the element is
// attached. The MutationObserver callback runs as a microtask — flush
// twice to allow chained microtasks (root observer → attach inner →
// inner fires) to settle.
async function spawnContextView(left: number, top: number): Promise<HTMLElement> {
  const el = document.createElement("div");
  el.className = "context-view";
  el.style.position = "fixed";
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  document.body.appendChild(el);
  await flushMutations();
  return el;
}

async function flushMutations(): Promise<void> {
  // Two microtask flushes: one for the root observer, one for any inner
  // observer it spawned that itself queued a write.
  await Promise.resolve();
  await Promise.resolve();
}

describe("installMonacoContextViewFix — integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setRootZoom(null);
    resetCoordSpaceCache();
    __resetMonacoContextViewFixForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setRootZoom(null);
    resetCoordSpaceCache();
    __resetMonacoContextViewFixForTests();
  });

  describe("baseline correction (webkit, zoom != 1)", () => {
    it("divides the initial left/top of a newly attached context-view by zoom", async () => {
      const restore = stubProbe("webkit", 1.5);
      setRootZoom(1.5);
      installMonacoContextViewFix();
      const el = await spawnContextView(300, 150);
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(el.style.top)).toBeCloseTo(100, 1);
      restore();
    });

    it("re-corrects when Monaco moves the menu after first show (re-position)", async () => {
      const restore = stubProbe("webkit", 1.5);
      setRootZoom(1.5);
      installMonacoContextViewFix();
      const el = await spawnContextView(300, 150);
      // Monaco repositions the menu (e.g. submenu expansion clamping).
      // Both writes happen in the same synchronous block — observer
      // delivers one callback with two records.
      el.style.left = "600px";
      el.style.top = "300px";
      await flushMutations();
      expect(parseFloat(el.style.left)).toBeCloseTo(400, 1);
      expect(parseFloat(el.style.top)).toBeCloseTo(200, 1);
      restore();
    });

    it("does NOT loop: observer doesn't keep re-dividing its own write", async () => {
      const restore = stubProbe("webkit", 2);
      setRootZoom(2);
      installMonacoContextViewFix();
      const el = await spawnContextView(400, 200);
      // First correction: 400/2 = 200, 200/2 = 100.
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      // Multiple flush cycles — if the observer were looping, we'd see
      // 200 → 100 → 50 → 25 etc.
      await flushMutations();
      await flushMutations();
      await flushMutations();
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(el.style.top)).toBeCloseTo(100, 1);
      restore();
    });
  });

  describe("no-op branches", () => {
    it("leaves left/top alone on Chromium (event coords already in layout frame)", async () => {
      const restore = stubProbe("chromium", 1.5);
      setRootZoom(1.5);
      installMonacoContextViewFix();
      const el = await spawnContextView(300, 150);
      expect(parseFloat(el.style.left)).toBe(300);
      expect(parseFloat(el.style.top)).toBe(150);
      restore();
    });

    it("leaves left/top alone at zoom == 1", async () => {
      setRootZoom(null);
      installMonacoContextViewFix();
      const el = await spawnContextView(300, 150);
      expect(parseFloat(el.style.left)).toBe(300);
      expect(parseFloat(el.style.top)).toBe(150);
    });
  });

  describe("known limitation: WeakMap echo guard false-skip", () => {
    // Codex's review (MAJOR finding #1) flagged this case. We accept it
    // as a known limitation rather than fix it, because the alternative
    // (disconnect-around-write) broke the menu in WKWebView when Monaco
    // delivers `style.top` and `style.left` writes as separate observer
    // callbacks — the disconnect window between them caused the first
    // callback to read a half-updated state and the second callback to
    // re-divide an already-corrected coordinate. Keeping the echo guard
    // means a synthetic edge case (Monaco intentionally repositioning
    // to coordinates that exactly equal a previous correction) is left
    // uncorrected; in exchange the common path is solid. This test
    // documents the trade-off.
    it("does NOT correct raw 200/100 after a prior raw 400/200 → 200/100 correction at zoom 2", async () => {
      const restore = stubProbe("webkit", 2);
      setRootZoom(2);
      installMonacoContextViewFix();
      const el = await spawnContextView(400, 200);
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      // Same values: echo guard treats it as our own write, skips.
      el.style.left = "200px";
      el.style.top = "100px";
      await flushMutations();
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(el.style.top)).toBeCloseTo(100, 1);
      restore();
    });
  });

  describe("codex finding #2 — re-attached `.context-view` doesn't stack inner observers", () => {
    it("re-correcting after a remove + re-add still produces one write per Monaco move", async () => {
      const restore = stubProbe("webkit", 2);
      setRootZoom(2);
      installMonacoContextViewFix();
      // First mount + correction.
      const el = await spawnContextView(400, 200);
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      // Monaco-style remove + re-add of the SAME node.
      document.body.removeChild(el);
      el.style.left = "400px";
      el.style.top = "200px";
      document.body.appendChild(el);
      await flushMutations();
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      // Move it again — we should see a single 200→100 correction, not
      // 200→100→50→… from stacked observers re-firing on the same write.
      el.style.left = "400px";
      el.style.top = "200px";
      await flushMutations();
      expect(parseFloat(el.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(el.style.top)).toBeCloseTo(100, 1);
      restore();
    });
  });

  // Note: there is NO test here for "Monaco writes top and left in
  // separate microtask checkpoints." Per the MutationObserver spec they
  // should coalesce when written sequentially in the same synchronous
  // block, and in practice WKWebView delivers Monaco's
  // `doLayout()` writes as a single callback — the running-app
  // verification at uiFontSize 16 confirms this. If we forced a split
  // in a test (e.g. `await` between writes), neither the WeakMap echo
  // guard nor the previously-tried disconnect-around-write handles it
  // cleanly — the second callback would re-divide the already-corrected
  // first coordinate. We don't simulate that pattern because it isn't
  // how the bug presents in production. If a future Monaco refactor
  // changes the timing, the manual QA matrix in the PR description
  // should catch it before any user does.

  describe("nested submenus", () => {
    it("corrects a `.context-view` attached as a descendant (Monaco submenu pattern)", async () => {
      const restore = stubProbe("webkit", 1.5);
      setRootZoom(1.5);
      installMonacoContextViewFix();
      const wrapper = document.createElement("div");
      const submenu = document.createElement("div");
      submenu.className = "context-view";
      submenu.style.position = "fixed";
      submenu.style.left = "300px";
      submenu.style.top = "150px";
      wrapper.appendChild(submenu);
      document.body.appendChild(wrapper);
      await flushMutations();
      expect(parseFloat(submenu.style.left)).toBeCloseTo(200, 1);
      expect(parseFloat(submenu.style.top)).toBeCloseTo(100, 1);
      restore();
    });
  });
});
