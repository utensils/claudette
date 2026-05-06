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
// but it never applied to the context view (see Monaco issue 1203,
// https://github.com/microsoft/monaco-editor/issues/1203 — open since
// 2018), so we can't fix this through Monaco's options. The
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

// Last position WE wrote to each target. Used to suppress the
// attribute-mutation feedback loop that re-firing the observer would
// otherwise cause: when the post-correction values match the last-written
// pair, we know Monaco hasn't moved the menu and skip.
//
// Trade-off vs codex's review (MAJOR finding #1): this guard CAN false-skip
// if Monaco genuinely repositions to coordinates that happen to equal a
// previous corrected pair (e.g. raw 200/100 after correcting raw 400/200
// → 200/100 at zoom 2). We accept that edge case — it requires the user
// to deliberately open a second menu at a position that exactly matches
// the prior corrected pair, which is rare. The earlier "fix" via
// disconnect-around-write was theoretically cleaner but shifted the
// failure mode: WKWebView appears to deliver Monaco's separate
// `style.top` and `style.left` writes as distinct callbacks, and the
// disconnect window between them caused the FIRST callback to read a
// half-updated state and re-divide the already-corrected coordinate on
// the SECOND callback — which broke the menu in the running app.
const lastApplied = new WeakMap<object, { left: number; top: number }>();

/**
 * Pure function — exported for tests. Reads `style.left/top` off `el`,
 * divides by `zoom`, and writes the corrected pair back. Skips when:
 *   - either coordinate is unparseable (Monaco hasn't mounted yet), or
 *   - the current values match the last pair WE wrote (echo of our own
 *     write firing the observer).
 *
 * Returns `true` when a write happened, `false` when it was skipped.
 */
export function correctContextViewPosition(
  el: PositionTarget,
  zoom: number,
): boolean {
  const left = parseFloat(el.style.left);
  const top = parseFloat(el.style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return false;

  const last = lastApplied.get(el as object);
  if (
    last &&
    Math.abs(last.left - left) < 0.5 &&
    Math.abs(last.top - top) < 0.5
  ) {
    return false;
  }

  const correctedLeft = left / zoom;
  const correctedTop = top / zoom;
  el.style.left = `${correctedLeft}px`;
  el.style.top = `${correctedTop}px`;
  lastApplied.set(el as object, { left: correctedLeft, top: correctedTop });
  return true;
}

// Test-only: clear the WeakMap-backed echo guard so tests don't leak the
// "last applied" state into the next case.
export function __resetCorrectionMemoForTests(el: object): void {
  lastApplied.delete(el);
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

function attachHostObserver(host: HTMLElement): void {
  // Dedup: if Monaco re-adds a `.context-view` we've already seen, reuse
  // the existing observer rather than stacking another one.
  if (hostObservers.has(host)) return;
  const inner = new MutationObserver(() => {
    const zoom = shouldCorrect();
    if (zoom === false) return;
    correctContextViewPosition(host, zoom);
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

// Track shadow roots we've observed so we don't double-attach on
// re-entry. Also a WeakSet because the shadow-root-host element is a
// regular DOM node that can be removed.
const observedShadowRoots = new WeakSet<ShadowRoot>();

function watchShadowRoot(root: ShadowRoot, zoom: number | false): void {
  if (observedShadowRoots.has(root)) return;
  observedShadowRoots.add(root);
  // Pick up any `.context-view` already inside.
  for (const host of root.querySelectorAll<HTMLElement>(".context-view")) {
    if (zoom !== false) correctContextViewPosition(host, zoom);
    attachHostObserver(host);
  }
  // Recursive: if this shadow root contains FURTHER shadow hosts, we'd
  // miss their roots otherwise — `MutationObserver` doesn't pierce
  // boundaries, so we have to walk explicitly. Monaco doesn't currently
  // nest shadow DOM, but defending against it is cheap (one extra
  // querySelectorAll on a freshly observed root) and prevents the
  // class of bug codex's review flagged.
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.shadowRoot) watchShadowRoot(el.shadowRoot, zoom);
  }
  // And subscribe so future additions are caught.
  const inner = new MutationObserver((records) => {
    const innerZoom = shouldCorrect();
    for (const r of records) {
      if (r.type !== "childList") continue;
      r.addedNodes.forEach((n) => visitAddedNode(n, innerZoom));
      r.removedNodes.forEach(visitRemovedNode);
    }
  });
  inner.observe(root, { childList: true, subtree: true });
}

function visitAddedNode(node: Node, zoom: number | false): void {
  if (!(node instanceof HTMLElement)) return;
  // 1. Direct/descendant `.context-view` in the light DOM. We always
  //    attach the per-host attribute observer here even at zoom == 1 —
  //    if the user later bumps `uiFontSize` to a non-default value, the
  //    inner observer is already in place and the very first menu show
  //    after that will be corrected on the next style write.
  const hosts = node.classList.contains("context-view")
    ? [node]
    : Array.from(node.querySelectorAll<HTMLElement>(".context-view"));
  for (const host of hosts) {
    if (zoom !== false) correctContextViewPosition(host, zoom);
    attachHostObserver(host);
  }
  // 2. Shadow roots: Monaco's StandaloneContextViewService can mount the
  //    context view INSIDE a shadow DOM (`<div class="shadow-root-host">`
  //    + `attachShadow({mode: 'open'})`), and MutationObserver does not
  //    pierce shadow boundaries. Attach a separate observer to each
  //    shadow root we encounter so the fix reaches the menu Monaco is
  //    actually rendering. Walk the subtree here because the shadow host
  //    can be a deep descendant of an added node.
  if (node.shadowRoot) watchShadowRoot(node.shadowRoot, zoom);
  for (const el of node.querySelectorAll<HTMLElement>("*")) {
    if (el.shadowRoot) watchShadowRoot(el.shadowRoot, zoom);
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
 * The observer is a permanent global; there's no uninstall. Steady-state
 * cost on a busy app is dominated by the per-batch DOM scan in
 * `visitAddedNode`: for every added subtree we run two `querySelectorAll`
 * passes (one for `.context-view`, one for `*` to discover shadow hosts).
 * The `*` pass is the expensive one — it scans the entire added subtree.
 *
 * That cost is paid even at zoom == 1, because we want the per-host
 * attribute observers attached and shadow roots tracked BEFORE the user
 * ever bumps their UI font size; otherwise the first menu show after a
 * zoom change would land uncorrected. In practice this is fine: chat /
 * terminal mutations are small subtrees, and Monaco menus are not
 * created on hot paths. If profiling ever surfaces this, the fastest
 * win is to gate `*` traversal behind a "have we ever observed a shadow
 * root before" flag, since shadow DOM is rare in this app.
 */
export function installMonacoContextViewFix(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;

  const start = () => {
    rootObserver = new MutationObserver((records) => {
      // Skip only the zoom-dependent CORRECTION when zoom == 1. We still
      // run `visitAddedNode` so per-host attribute observers and shadow
      // roots are tracked — that's what lets a later zoom change take
      // effect immediately on the next menu show.
      const zoom = shouldCorrect();
      for (const r of records) {
        if (r.type !== "childList") continue;
        r.addedNodes.forEach((n) => visitAddedNode(n, zoom));
        r.removedNodes.forEach(visitRemovedNode);
      }
    });
    rootObserver.observe(document.body, { childList: true, subtree: true });
    // Seed: scan once for any `.context-view` and shadow roots that
    // already exist at install time. Monaco's StandaloneContextViewService
    // creates its persistent host element when the editor mounts, which
    // typically happens BEFORE this install runs.
    const seedZoom = shouldCorrect();
    visitAddedNode(document.body, seedZoom);
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
  // WeakMap / WeakSet can't be cleared explicitly — but each test
  // creates fresh host objects, so previous entries simply get GC'd.
  // The shadow-root attribute observers we created via `watchShadowRoot`
  // aren't tracked in a list (they live in closure scope), but they're
  // unreachable once the host element is GC'd, so they don't leak across
  // tests in practice. If a future test hangs onto a shadow host across
  // cases, replace the WeakSet here with a Map<ShadowRoot, MutationObserver>
  // and disconnect explicitly.
}
