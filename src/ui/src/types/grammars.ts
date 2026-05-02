/**
 * Frontend types for the `language-grammar` plugin kind. Mirrors
 * `claudette::grammar_provider` in the Rust backend. Frontend uses
 * these to register Monaco languages and seed Shiki's known-language
 * list at app bootstrap; each grammar's TextMate JSON is fetched
 * eagerly via {@link readLanguageGrammar} during that bootstrap (see
 * `utils/grammarRegistry.ts`) so the first highlight request after
 * boot doesn't pay a backend round-trip. Lazy per-language load is a
 * future enhancement gated on usage data showing it matters.
 */

/** Metadata for a language declared by a plugin. */
export interface LanguageInfo {
  /** Plugin that contributed this language. */
  plugin_name: string;
  /** Stable language id (e.g. `"nix"`). Matches a `GrammarInfo.language`. */
  id: string;
  /** File extensions including the leading dot. */
  extensions: string[];
  /** Exact filenames associated with the language regardless of extension. */
  filenames: string[];
  /** Display aliases — first entry is typically the human-readable name. */
  aliases: string[];
  /**
   * Optional regex to match against a file's first line when neither
   * extension nor filename rules apply. JavaScript regex semantics.
   */
  first_line_pattern: string | null;
}

/** Metadata for a TextMate grammar contributed by a plugin. */
export interface GrammarInfo {
  /** Plugin that contributed this grammar. */
  plugin_name: string;
  /** Language id this grammar binds to (must match a {@link LanguageInfo.id}). */
  language: string;
  /** Top-level scope name (e.g. `"source.nix"`). */
  scope_name: string;
  /**
   * Plugin-relative path to the grammar JSON. Treat as opaque — the
   * frontend passes it back to {@link readLanguageGrammar} verbatim.
   */
  path: string;
}

/**
 * Combined snapshot returned by {@link listLanguageGrammars}. Languages
 * and grammars are listed separately because a language can be
 * declared without a grammar (metadata-only stub) and a grammar always
 * references a language id.
 */
export interface GrammarRegistry {
  languages: LanguageInfo[];
  grammars: GrammarInfo[];
}
