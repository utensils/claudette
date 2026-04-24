/**
 * Trim trailing spaces/tabs from each line of a terminal selection.
 *
 * xterm.js renders on a fixed cell grid — a selection that sweeps across
 * lines shorter than the terminal width includes the blank trailing cells
 * as space characters. Native macOS terminals (Terminal.app, iTerm2,
 * Ghostty) trim those at copy time; we do the same here so pasted text
 * doesn't come out ragged with phantom trailing whitespace.
 */
export function trimSelectionTrailingWhitespace(selection: string): string {
  return selection
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}
