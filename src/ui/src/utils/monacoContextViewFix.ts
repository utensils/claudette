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

// Last position WE wrote to each target. Used to suppress the
// attribute-mutation feedback loop that re-firing the observer would
// otherwise cause: when the post-correction values match the last-written
// pair, we know Monaco hasn't moved the menu and skip.
const lastApplied = new WeakMap<object, { left: number; top: number }>();

/**
 * Pure function — exported for tests. Reads `style.left/top` off `el`,
 * divides by `zoom`, and writes the corrected pair back. Skips when:
 *   - either coordinate is unparseable (Monaco hasn't mounted yet), or
 *   - the current values match the last pair WE wrote (echo of our own
 *     write firing the observer).
 *
 * Returns `true` when a write happened, `false` when it was skipped —
 * the test suite uses this to assert the no-loop guarantee.
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
let observer: MutationObserver | null = null;

function shouldCorrect(): false | number {
  const zoom = getRootZoom();
  if (zoom === 1) return false;
  if (eventCoordSpace() !== "visual") return false;
  return zoom;
}

function observeContextView(el: HTMLElement): void {
  // Monaco re-positions the menu while open in a few cases (resize, submenu
  // expansion, viewport edge clamping) by setting style.left/top again. An
  // attribute observer on the host catches each of those.
  const inner = new MutationObserver(() => {
    const zoom = shouldCorrect();
    if (zoom === false) return;
    correctContextViewPosition(el, zoom);
  });
  inner.observe(el, { attributes: true, attributeFilter: ["style"] });
  // The inner observer is GC'd with the element on subtree removal — we
  // don't track it explicitly. WeakMap entries clear at the same time.
}

/**
 * Install a single document-wide observer that corrects Monaco's
 * `.context-view` positioning under html zoom on WebKit. Idempotent: a
 * second call is a no-op. Safe to call before `document.body` exists —
 * we'll defer until DOM is ready.
 *
 * The observer is a permanent global; there's no uninstall. Cost is one
 * MutationObserver on `document.body` (childList, subtree) plus a small
 * inner observer per `.context-view` element. Both branches early-out at
 * zoom == 1 or on Chromium.
 */
export function installMonacoContextViewFix(): void {
  if (installed) return;
  if (typeof document === "undefined") return;
  installed = true;

  const start = () => {
    // `.context-view` is mounted as a direct child of `<body>` (or in some
    // versions, a child of the editor's overflow container). A subtree
    // observer covers both.
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== "childList") continue;
        r.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          // Match both the host and any nested `.context-view` (Monaco
          // sometimes wraps submenus in their own context-view).
          const hosts = n.classList.contains("context-view")
            ? [n]
            : Array.from(n.querySelectorAll<HTMLElement>(".context-view"));
          for (const host of hosts) {
            const zoom = shouldCorrect();
            if (zoom !== false) correctContextViewPosition(host, zoom);
            observeContextView(host);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.body) {
    start();
  } else {
    // main.tsx imports monacoSetup lazily, so body should exist by then —
    // but DOMContentLoaded is the safe fallback for very early boots.
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }
}

// Test-only: tear down the global observer between cases. Production code
// never calls this — the observer is meant to live for the lifetime of the
// app.
export function __resetMonacoContextViewFixForTests(): void {
  observer?.disconnect();
  observer = null;
  installed = false;
}
