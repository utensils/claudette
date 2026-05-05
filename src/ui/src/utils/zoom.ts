// Read the html-level CSS zoom that `applyUserFonts` sets to scale the UI
// (theme.ts). Returns 1 when zoom is unset or invalid so callers can branch
// cheaply on `zoom !== 1`.
export function getRootZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// WebKit on macOS (used by Tauri's WKWebView) reports `clientX/Y` in event
// handlers in *visual* (post-zoom) pixels, while CSS `position: fixed; left/top`
// interpret their values in *layout* (pre-zoom) pixels. Without compensation
// a fixed element placed at the click coords renders shifted by the zoom
// factor — visibly off when zoom != 1. Divide event coords by zoom to land
// the element at the cursor.
export function viewportToFixed(x: number, y: number) {
  const z = getRootZoom();
  if (z === 1) return { x, y };
  return { x: x / z, y: y / z };
}

// Visual viewport size in layout pixels — the right reference for clamping
// a fixed-positioned element since fixed `left/top` are layout pixels too.
// `window.innerWidth/innerHeight` return visual pixels under html zoom, so
// we divide back into the same frame the placement is in.
export function viewportLayoutSize() {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  const z = getRootZoom();
  return {
    width: window.innerWidth / z,
    height: window.innerHeight / z,
  };
}
