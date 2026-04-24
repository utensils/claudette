/**
 * Clean up a terminal selection for the clipboard to match native-terminal
 * behavior (Terminal.app, iTerm2, Ghostty):
 *
 * 1. Rstrip trailing spaces/tabs on every line. xterm.js renders on a fixed
 *    cell grid, so a selection that sweeps across lines shorter than the
 *    terminal width captures the blank trailing cells as space characters.
 * 2. Drop trailing all-empty lines. If the user drags the selection past
 *    the last row of real output into the blank area below, those empty
 *    rows come back as empty lines and would paste as unwanted blank
 *    lines. Native terminals clip the selection at the last line of
 *    content; we emulate that at copy time.
 *
 * A single trailing newline is preserved if the original selection ended
 * with one, so a line-anchored selection still pastes as a full line.
 * Leading blank lines are kept — they may be intentional spacing between
 * paragraphs of output.
 */
export function trimSelectionTrailingWhitespace(selection: string): string {
  if (selection === "") return "";
  const endsWithNewline = selection.endsWith("\n");
  const lines = selection
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) return "";
  return lines.join("\n") + (endsWithNewline ? "\n" : "");
}
