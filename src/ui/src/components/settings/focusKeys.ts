/**
 * Stable identifiers used by `openSettings(section, focus)` to scroll a
 * specific row into view and highlight it after navigation. Living here
 * (rather than in the section components themselves) keeps the chat
 * composer's import graph free of settings-only CSS / component code —
 * a stray `import { ... } from ".../sections/ExperimentalSettings"`
 * would otherwise pull settings styles into the composer chunk.
 *
 * Add a new key whenever you wire a new settings deep-link target.
 */

/** Anchor + state key for the experimental "Claude Code Usage" row. */
export const CLAUDE_CODE_USAGE_FOCUS = "claude-code-usage";
