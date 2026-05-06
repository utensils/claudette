// Monaco renders its context menu, suggestion menus, and quick-input pickers
// into a `position: fixed` element with class `.context-view`. Its position
// is set from `MouseEvent.clientX/Y` (or anchor `getBoundingClientRect()`),
// in pixels, written directly to `style.left` / `style.top`.
//
// Under the html-level CSS `zoom` Claudette uses for UI scaling, that math
// is engine-dependent:
//
//   - WebKit (WKWebView, WebKitGTK) reports clientX/Y and rect coords in
//     visual pixels, while CSS `position: fixed; left/top` interprets values
//     in layout pixels — so Monaco's `style.left = clientX + 'px'` lands the
//     menu at visual `clientX * zoom`, shifted past the cursor.
//
//   - Chromium (WebView2) treats the entire pipeline in the layout frame, so
//     Monaco's math is already correct.
//
// `fixedOverflowWidgets` is an editor option that lifts widgets to body —
// but it never applied to the context view (microsoft/monaco-editor#1203,
// open since 2018), so we can't fix this through Monaco's options. The
// recommended workaround is to leave the menu where Monaco mounts it and
// correct its position after the fact. That's what this module does:
// observe `.context-view` mounts, divide `style.left/top` by zoom on
// engines that need it, leave everything else (menu contents, keyboard
// nav, focus management, language-server actions) untouched.

import { eventCoordSpace, getRootZoom } from "./zoom";

// Minimal element shape the correction touches — extracted so the core
// math is testable without a DOM. The runtime callers always pass real
// HTMLElements; tests pass a stub.
export interface PositionTarget {
  style: { left: string; top: string };
}

/**
 * Pure function — exported for tests. Reads `style.left/top` off `el`,
 * divides by `zoom`, and writes the corrected pair back. Skips silently
 * when either coordinate is unparseable (Monaco hasn't mounted yet).
 *
 * Returns `true` when a write happened, `false` when it was skipped.
 *
 * Note: this function does NOT guard against the observer feedback loop.
 * The runtime caller below disconnects the per-host MutationObserver
 * around its writes — which is more reliable than a value-equality echo
 * guard, because Monaco can legitimately re-position to coordinates that
 * happen to match a previous corrected pair (e.g. raw 200/100 after
 * we just corrected raw 400/200 → 200/100 at zoom 2).
 */
export function correctContextViewPosition(
  el: PositionTarget,
  zoom: number,
): boolean {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;
  el.style.left = `${left / zoom}px`;
  el.style.top = `${top / zoom}px`;
  return true;
}

let installed = false;
let rootObserver: MutationObserver | null = null;
// Per-host attribute observers, keyed by the `.context-view` element. A
// `WeakMap` lets the entry GC with the host if Monaco drops it without
// going through our removed-nodes path; the explicit dedup keeps a stale
// observer from stacking when Monaco re-attaches the same node.
const hostObservers = new WeakMap<HTMLElement, MutationObserver>();

function shouldCorrect(): false | number {
  const zoom = getRootZoom();
  if (zoom === 1) return false;
  if (eventCoordSpace() !== "visual") return false;
  return zoom;
}

// Disconnect around our own writes so the inner observer never sees them.
// This is more robust than a value-equality echo guard: at zoom 2, raw
// 200/100 (which Monaco can legitimately set as a NEW position) cannot be
// distinguished from the post-correction value of a prior raw 400/200 by
// equality alone.
function applyCorrection(host: HTMLElement, zoom: number): void {
  const inner = hostObservers.get(host);
  inner?.disconnect();
  correctContextViewPosition(host, zoom);
  // Re-attach so future Monaco-driven style writes still trigger us.
  inner?.observe(host, { attributes: true, attributeFilter: ["style"] });
}

function attachHostObserver(host: HTMLElement): void {
  // Dedup: if Monaco re-adds a `.context-view` we've already seen, reuse
  // the existing observer rather than stacking another one.
  if (hostObservers.has(host)) return;
  const inner = new MutationObserver(() => {
    const zoom = shouldCorrect();
    if (zoom === false) return;
    applyCorrection(host, zoom);
  });
  inner.observe(host, { attributes: true, attributeFilter: ["style"] });
  hostObservers.set(host, inner);
}

function detachHostObserver(host: HTMLElement): void {
  const inner = hostObservers.get(host);
  if (!inner) return;
  inner.disconnect();
  hostObservers.delete(host);
}

function visitAddedNode(node: Node, zoom: number | false): void {
  if (!(node instanceof HTMLElement)) return;
  const hosts = node.classList.contains("context-view")
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(".context-view"));
  for (const host of hosts) {
    if (zoom !== false) applyCorrection(host, zoom);
    attachHostObserver(host);
  }
}

function visitRemovedNode(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (node.classList.contains("context-view")) {
    detachHostObserver(node);
  }
  for (const host of node.querySelectorAll<HTMLElement>(".context-view")) {
    detachHostObserver(host);
  }
}

/**
 * Install a single document-wide observer that corrects Monaco's
 * `.context-view` positioning under html zoom on WebKit. Idempotent: a
 * second call is a no-op. Safe to call before `document.body` exists —
 * we'll defer until DOM is ready.
 *
 * The observer is a permanent global; there's no uninstall. Cost is one
 * MutationObserver on `document.body` (childList, subtree). The callback
 * early-outs at zoom == 1 before doing any DOM scanning, so the steady-
 * state overhead during chat/terminal streaming is one cheap zoom read
 * per batch of mutation records.
 */
export function installMonacoContextViewFix(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;

  const start = () => {
    rootObserver = new MutationObserver((records) => {
      // Cheap perf gate: at zoom 1 the fix is unconditionally a no-op, so
      // skip the per-mutation `querySelectorAll` scan that would otherwise
      // run on every chat/terminal append.
      const zoom = getRootZoom() === 1 ? false : shouldCorrect();
      for (const r of records) {
        if (r.type !== "childList") continue;
        r.addedNodes.forEach((n) => visitAddedNode(n, zoom));
        r.removedNodes.forEach(visitRemovedNode);
      }
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });
  };

  if (document.body) {
    start();
  } else {
    // main.tsx imports monacoSetup lazily, so body should exist by then —
    // but DOMContentLoaded is the safe fallback for very early boots.
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

// Test-only: tear down the global observer + per-host map between cases.
// Production code never calls this — the observer is meant to live for
// the lifetime of the app.
export function __resetMonacoContextViewFixForTests(): void {
  rootObserver?.disconnect();
  rootObserver = null;
  installed = false;
  // WeakMap can't be cleared explicitly — but each test creates fresh
  // host objects, so previous entries simply get GC'd.
}
