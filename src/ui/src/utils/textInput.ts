export const PLAIN_TEXT_INPUT_PROPS = {
  // Disable every browser-side text-massaging behavior. These inputs hold
  // raw content — shell scripts, identifiers, env var names, custom
  // instructions — where any auto-fix or autofill is a regression, not a
  // convenience. `autoComplete: "off"` suppresses the browser's
  // remembered-form suggestions; the others stop iOS/Safari from
  // capitalizing or "correcting" what the user typed.
  autoComplete: "off",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

export function normalizeShellScriptInput(value: string): string {
  return value
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}
