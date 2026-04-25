/**
 * After a split, the shell's SIGWINCH handler (zsh's zle `reset-prompt`,
 * powerlevel10k, starship's zle-line-init, etc.) typically moves the cursor
 * to (0,0) and clears to end of display. Scrollback stays intact but the
 * visible viewport is wiped and the prompt ends up alone at the top — which
 * users read as "the split truncated my output".
 *
 * This helper decides how many lines to scroll the xterm display UP so the
 * cursor sits near the bottom of the viewport, exposing the preserved
 * history above. The returned value is suitable for `Terminal.scrollLines`:
 * a negative number moves the view up by that many rows; `0` means leave
 * the scroll position alone.
 *
 * Heuristic:
 *   - We only adjust when the cursor landed in the upper half of the
 *     viewport (a strong signal the shell issued a clear-and-redraw).
 *   - We only adjust when there's scrollback to expose (`baseY > 0`).
 *   - We cap the scroll by the amount of scrollback actually available, so
 *     we never scroll past the top of the buffer.
 */
export interface ReclaimInput {
  rows: number;
  cursorY: number;
  baseY: number;
}

export function reclaimScrollLines(input: ReclaimInput): number {
  const { rows, cursorY, baseY } = input;
  if (rows <= 1) return 0;
  if (baseY <= 0) return 0;
  if (cursorY >= Math.floor(rows / 2)) return 0;
  const slack = rows - 1 - cursorY;
  if (slack <= 0) return 0;
  const lines = Math.min(slack, baseY);
  return -lines;
}
