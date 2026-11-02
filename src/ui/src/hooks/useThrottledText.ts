import { useEffect, useRef, useState } from "react";

/**
 * Re-publish a fast-changing string at most once per `intervalMs`, always
 * delivering the latest value on the trailing edge.
 *
 * Used for the streaming assistant message: the typewriter advances every
 * other animation frame, and each advance re-parsed the *entire* growing
 * reply through remark/rehype — total work quadratic in reply length, which
 * made long answers stutter toward the end. Short replies (below
 * `minLength`) and the disabled case pass straight through so the common
 * case keeps its per-frame smoothness.
 */
export function useThrottledText(
  text: string,
  {
    intervalMs,
    minLength = 0,
    enabled = true,
  }: { intervalMs: number; minLength?: number; enabled?: boolean },
): string {
  const throttle = enabled && text.length >= minLength;
  const [published, setPublished] = useState(text);
  const lastPublishRef = useRef(0);
  // While passing through, keep `published` tracking the input so the
  // moment throttling kicks in it holds the latest text rather than
  // whatever was current at mount (which would flash a truncated reply).
  // Render-phase update: React re-runs this component before committing.
  if (!throttle && published !== text) setPublished(text);

  useEffect(() => {
    if (!throttle) return;
    const wait = lastPublishRef.current + intervalMs - Date.now();
    if (wait <= 0) {
      lastPublishRef.current = Date.now();
      setPublished(text);
      return;
    }
    const id = setTimeout(() => {
      lastPublishRef.current = Date.now();
      setPublished(text);
    }, wait);
    return () => clearTimeout(id);
  }, [intervalMs, text, throttle]);

  return throttle ? published : text;
}
