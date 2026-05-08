import { useEffect, useState } from "react";

function readIsLight(): boolean {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("color-scheme")
      .trim() === "light"
  );
}

/**
 * Tracks whether the active Claudette theme is light or dark by reading the
 * computed `color-scheme` CSS variable on `<html>`. Re-evaluates whenever
 * `data-theme` or inline style changes on the root element — same trigger
 * surface used by the Monaco theme sync.
 */
export function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(readIsLight);

  useEffect(() => {
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
