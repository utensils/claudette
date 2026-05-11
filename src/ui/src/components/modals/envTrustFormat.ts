/**
 * Display formatters shared by `EnvTrustModal` and the `EnvPanel`
 * trust-prompt entry point. Extracted into its own module so we can
 * unit-test the regex / string-math directly without spinning up the
 * whole modal — both functions have shipped regression-causing bugs
 * we'd rather not re-roll.
 *
 * Stay aligned with the backend cleaner in
 * `src-tauri/src/commands/env.rs` (`clean_trust_error_excerpt`,
 * `strip_lua_wrapper`, the `clean_mise` / `clean_direnv` pipeline) —
 * if either side gets a new prefix to strip, mirror it here so the
 * proactive-from-Settings path keeps producing the same text as the
 * event-driven path.
 */

/**
 * Trim a raw plugin error string to a single readable line for the
 * `EnvTrustModal`'s `message` field. Strips, in order:
 *
 *   1. ANSI SGR escape sequences (`\x1b[31m`, `\x1b[0m` — direnv
 *      tints its `is blocked` line red and emits a reset code at the
 *      end, both of which leak through to the modal if untouched).
 *   2. `export: ` dispatcher prefix from `plugin.export()` failures.
 *   3. `Plugin script error: runtime error: ` mlua wrapper.
 *   4. `[string "..."]:N: ` Lua call-site location.
 *   5. Collapse to first line, trim, truncate to 240 chars.
 *
 * Order matters: the dispatcher prefix wraps the mlua wrapper which
 * wraps the Lua location, so we must strip outside-in.
 */
export function summarizeError(error: string): string {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[\d;]*m/g;
  const cleaned = error
    .replace(ANSI, "")
    .replace(/^export:\s*/i, "")
    .replace(/Plugin script error:\s*runtime error:\s*/i, "")
    .replace(/\[string "[^"]*"\]:\d+:\s*/, "")
    .trim();
  return cleaned.split("\n")[0].slice(0, 240);
}

/**
 * Format wall-clock elapsed milliseconds as a compact human label for
 * the in-flight Trust / Disable buttons. Returns `${n}s` for
 * sub-minute durations and `${m}m ${s}s` past a minute. The unit is
 * embedded — translation strings must NOT append another `s`
 * (regression caught in UAT: `Trusting… 5ss`).
 *
 * Guards against clock skew / negative inputs by clamping to 0.
 */
export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
