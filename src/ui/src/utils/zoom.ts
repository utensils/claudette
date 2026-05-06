// Read the html-level CSS zoom that `applyUserFonts` sets to scale the UI
// (theme.ts). Returns 1 when zoom is unset or invalid so callers can branch
// cheaply on `zoom !== 1`.
export function getRootZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// CSS `zoom` is non-standard, and engines disagree about whether
// `MouseEvent.clientX/Y`, `getBoundingClientRect()`, and the `position: fixed;
// left/top` used-value live in **visual** (post-zoom) or **layout** (pre-zoom)
// pixels:
//
//   - WebKit (WKWebView on macOS, WebKitGTK on Linux) reports event coords
//     and rects in visual pixels, while CSS `left/top` are interpreted in
//     layout pixels. To place a `position: fixed` element under the cursor
//     the click coords must be divided by the zoom factor.
//
//   - Chromium (WebView2 on Windows) applies zoom uniformly: event coords,
//     rects, and CSS used-values all live in the same (layout) frame. No
//     compensation is needed; dividing would over-correct and shift the
//     element toward the top-left.
//
// We pick the right branch with a behavior probe — render a fixed element at
// a known offset and read back its rect. If the engine reports the rect in
// the layout frame, `clientX` is in the layout frame too (no divide). If it
// reports in the visual frame, divide. The answer is engine-stable, so we
// cache it once we've seen a zoom != 1 the probe can actually distinguish.
type CoordSpace = "visual" | "layout";

let cachedCoordSpace: CoordSpace | null = null;

// Exposed so dev tooling / tests that mutate root zoom at runtime can force
// a re-probe. Production code never calls this — the answer is engine-stable.
export function resetCoordSpaceCache(): void {
  cachedCoordSpace = null;
}

function probeCoordSpace(): CoordSpace {
  if (typeof document === "undefined" || !document.body) return "visual";
  const z = getRootZoom();
  // At zoom == 1 the two frames coincide, so the probe can't distinguish.
  // Caller falls back to the WebKit-style answer; we just don't cache it.
  if (z === 1) return "visual";
  const probe = document.createElement("div");
  // Hidden 100px-wide marker placed at a non-zero offset. `pointer-events:
  // none` and `visibility: hidden` keep it from interfering with anything
  // already on screen during the few microseconds it lives.
  probe.style.cssText =
    "position:fixed;left:100px;top:0;width:100px;height:1px;" +
    "pointer-events:none;visibility:hidden;contain:strict;";
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  document.body.removeChild(probe);
  // WebKit returns rect.left ≈ 100 * z (rect is visual-frame). Chromium
  // returns rect.left ≈ 100 (rect is layout-frame). Pick whichever the
  // measured value is closer to so sub-pixel rounding doesn't tip the
  // answer.
  const visual = 100 * z;
  const layout = 100;
  return Math.abs(rect.left - visual) < Math.abs(rect.left - layout)
    ? "visual"
    : "layout";
}

// Returns which frame `MouseEvent.clientX/Y` live in for the current engine.
// Cached after the first zoom != 1 call.
export function eventCoordSpace(): CoordSpace {
  if (cachedCoordSpace !== null) return cachedCoordSpace;
  const result = probeCoordSpace();
  // Only lock in the answer once the probe could actually distinguish the
  // two frames. At zoom=1 it returns "visual" by convention; we don't want
  // to bake that in before the user ever bumps `uiFontSize`.
  if (typeof document !== "undefined" && getRootZoom() !== 1) {
    cachedCoordSpace = result;
  }
  return result;
}

// Translate event clientX/Y into the frame `position: fixed; left/top` uses,
// so a fixed element placed at the result lands under the cursor. On engines
// where the two frames already coincide, this is a no-op — see
// `eventCoordSpace` for the engine matrix.
export function viewportToFixed(x: number, y: number) {
  const z = getRootZoom();
  if (z === 1) return { x, y };
  if (eventCoordSpace() === "layout") return { x, y };
  return { x: x / z, y: y / z };
}

// Visual viewport size translated into the layout frame — the right reference
// for clamping a fixed-positioned element since fixed `left/top` are layout
// pixels under WebKit. On Chromium `window.innerWidth/innerHeight` already
// live in the layout frame, so we leave them alone.
export function viewportLayoutSize() {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  const z = getRootZoom();
  if (z === 1 || eventCoordSpace() === "layout") {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  return {
    width: window.innerWidth / z,
    height: window.innerHeight / z,
  };
}
