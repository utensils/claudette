// Single source of truth for the default font stacks referenced from both
// CSS (`--font-sans` / `--font-mono` in styles/theme.css) and TypeScript
// (Monaco's `fontFamily` and the user-font fallback in utils/theme.ts).
//
// Monaco computes glyph widths via `canvas.measureText`, which does NOT
// resolve CSS custom properties — so the editor must be configured with a
// literal font stack. To prevent the literal from drifting away from
// `--font-mono`, scripts/check-font-mono.mjs (run as part of `lint:css`)
// parses both files and asserts they match after whitespace normalization.
//
// Edit one place: change the value here, then mirror it into theme.css.
// The drift check is what catches a missed update.

export const DEFAULT_SANS_STACK =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const DEFAULT_MONO_STACK =
  '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace';
