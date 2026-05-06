// Keep the menu fully on-screen: if the click is close enough to the right or
// bottom edge, shift the anchor so the menu opens up/left instead of clipping.
export function clampMenuToViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
) {
  const maxX = viewportWidth - width - margin;
  const maxY = viewportHeight - height - margin;
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY)),
  };
}
