import { useState, useEffect } from "react";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../utils/spinnerFrames";

/**
 * Returns the current Braille spinner character.
 * When `active` is false, no interval runs and the returned value is the first frame.
 */
export function useSpinnerFrame(active: boolean): string {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!active) {
      setIdx(0);
      return;
    }
    const interval = setInterval(() => {
      setIdx((i) => (i + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active]);

  return SPINNER_FRAMES[idx];
}
