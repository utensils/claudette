import { useEffect, useState } from "react";

function readIsLight(): boolean {
  // vitest defaults to a Node environment in this repo (happy-dom is opt-in
  // per file via `// @vitest-environment happy-dom`), so any non-DOM caller
  // — including a future test that imports a component using this hook —
  // gets the dark default rather than a `document is not defined` crash.
  if (typeof document === "undefined") return false;
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("color-scheme")
      .trim() === "light"
  );
}

/**
 * Tracks whether the active Claudette theme is light or dark by reading the
 * computed `color-scheme` CSS property on `<html>`. Re-evaluates whenever
 * `data-theme` or inline style changes on the root element — same trigger
 * surface used by the Monaco theme sync.
 */
export function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(readIsLight);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      const next = readIsLight();
      setIsLight((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    return () => observer.disconnect();
  }, []);

  return isLight;
}
