// Claudette's Shiki theme — maps TextMate scopes onto the `--syntax-*`
// CSS custom properties declared in `theme.css`. By using CSS `var()`
// references as the foreground values (instead of literal hex), the
// emitted inline `style="color: var(--syntax-keyword)"` resolves
// per-theme at render time. A single Shiki theme covers all 14 built-in
// Claudette themes AND every imported Base16 scheme — the cascade does
// the work.
//
// Implementation note: Shiki's theme normalizer accepts any string in
// the `foreground` field and emits it verbatim as the value of the
// inline `style="color: <value>"`. CSS `var(...)` is a legal property
// value, so the browser resolves it without further machinery.

import type { ThemeRegistration } from "shiki/core";

export const CLAUDETTE_SHIKI_THEME_NAME = "claudette";

// Scope mappings follow the Base16 syntax roles (base08–base0F) so that
// imported Base16 schemes produce coherent highlighting end-to-end:
//   base08 → variable     base0C → operator
//   base09 → number       base0D → function
//   base0A → type         base0E → keyword
//   base0B → string       base0F → (legacy/deprecated)
// Comments map to base03 via the dedicated --syntax-comment.
//
// Each rule lists multiple TextMate scopes so the same color applies
// regardless of which grammar tagged the token. Shiki resolves the
// most specific scope match first, so broader scopes (e.g. "keyword")
// act as fallbacks for grammars that don't emit the finer-grained
// "keyword.control" / "keyword.operator" distinction.
const SCOPE_RULES: ReadonlyArray<{ scope: string[]; var: string }> = [
  {
    scope: ["comment", "comment.line", "comment.block", "punctuation.definition.comment"],
    var: "--syntax-comment",
  },
  {
    scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"],
    var: "--syntax-string",
  },
  {
    scope: [
      "constant.numeric",
      "constant.language",
      "constant.character",
      "constant.character.escape",
      "constant.other",
    ],
    var: "--syntax-number",
  },
  {
    scope: [
      "entity.name.function",
      "support.function",
      "meta.function-call entity.name.function",
      "meta.function-call",
    ],
    var: "--syntax-function",
  },
  {
    scope: [
      "entity.name.type",
      "entity.name.class",
      "entity.other.inherited-class",
      "support.type",
      "support.class",
      "entity.name.tag",
      "meta.type.annotation entity.name",
    ],
    var: "--syntax-type",
  },
  {
    scope: [
      "variable",
      "variable.parameter",
      "variable.other",
      "variable.language",
      "meta.definition.variable variable",
    ],
    var: "--syntax-variable",
  },
  {
    scope: [
      "keyword.operator",
      "punctuation",
      "punctuation.separator",
      "punctuation.terminator",
      "meta.brace",
    ],
    var: "--syntax-operator",
  },
  {
    // Keyword is the broadest fallback for control flow, modifiers, and
    // storage. Listed last so the more specific scopes above win when
    // both match.
    scope: [
      "keyword",
      "keyword.control",
      "keyword.declaration",
      "storage",
      "storage.type",
      "storage.modifier",
      "support.type.property-name",
    ],
    var: "--syntax-keyword",
  },
];

export function buildClaudetteShikiTheme(): ThemeRegistration {
  return {
    name: CLAUDETTE_SHIKI_THEME_NAME,
    // `type` is metadata for theme switchers — Shiki doesn't care about it
    // when emitting inline-style output, so "dark" here is a non-load-
    // bearing default. Light/dark switching happens via the underlying
    // CSS tokens themselves.
    type: "dark",
    settings: SCOPE_RULES.map((rule) => ({
      scope: rule.scope,
      settings: { foreground: `var(${rule.var})` },
    })),
    // Editor surface colors. Shiki uses these for the synthesized <pre>
    // wrapper that we strip in the worker, but keeping them as tokens
    // means a code block extracted with the wrapper still themes
    // correctly downstream (e.g. when rendered standalone in tests).
    colors: {
      "editor.background": "var(--app-bg)",
      "editor.foreground": "var(--text-primary)",
    },
  };
}
