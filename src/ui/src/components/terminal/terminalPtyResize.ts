export interface PtySizeSnapshot {
  cols: number;
  rows: number;
}

/**
 * Returns true when the frontend should forward a PTY resize to Rust.
 *
 * Identical back-to-back resizes still trigger SIGWINCH in the shell, which
 * makes prompt-redraw handlers run twice and shows up as duplicate prompts or
 * extra blank rows after a split.
 */
export function shouldForwardPtyResize(
  lastSize: PtySizeSnapshot | null,
  nextSize: PtySizeSnapshot,
): boolean {
  if (nextSize.cols <= 0 || nextSize.rows <= 0) return false;
  return (
    lastSize == null ||
    lastSize.cols !== nextSize.cols ||
    lastSize.rows !== nextSize.rows
  );
}
