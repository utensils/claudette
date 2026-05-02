/**
 * Tauri-backed accessors for the `language-grammar` plugin kind.
 * Thin invoke wrappers — all logic (path-traversal protection, size
 * caps, manifest filtering) lives on the Rust side in
 * `claudette::grammar_provider`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GrammarRegistry } from "../types/grammars";

/**
 * Snapshot of every enabled `language-grammar` plugin's contributed
 * languages and grammars. Cheap — reads in-memory registry state. No
 * grammar bytes are loaded.
 */
export function listLanguageGrammars(): Promise<GrammarRegistry> {
  return invoke("list_language_grammars");
}

/**
 * Read the JSON body of one grammar. The path must match an entry the
 * plugin's manifest declared in its `grammars` slot — the backend
 * rejects undeclared paths with a `PathOutsidePlugin` error to defend
 * against a compromised webview reading arbitrary plugin files.
 *
 * Returns the raw JSON string so the caller can `JSON.parse` it once
 * and feed Shiki / Monaco directly.
 */
export function readLanguageGrammar(
  pluginName: string,
  path: string,
): Promise<string> {
  return invoke("read_language_grammar", { pluginName, path });
}
