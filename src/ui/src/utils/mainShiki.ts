/**
 * Main-thread Shiki highlighter — sibling to the worker-based one in
 * `utils/highlight.ts`. The worker covers chat code blocks and the
 * diff viewer; the main-thread instance exists because
 * `@shikijs/monaco` requires a Shiki highlighter that lives in the
 * same realm as Monaco. Running Shiki in a worker for Monaco isn't
 * an option: Monaco's tokenization API is synchronous and runs on the
 * main thread.
 *
 * The two highlighters are otherwise independent. They share the
 * theme set (`github-light` / `github-dark`) but each loads its own
 * grammars on demand — Oniguruma WASM is therefore parsed twice
 * (~300 KB extra), which is acceptable for the tokenization quality
 * gain in the editor surface.
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Lazy singleton — first caller pays the WASM + theme bootstrap; all
 * subsequent calls hit the cached promise. Themes are bundled
 * statically; languages are loaded explicitly via `loadLanguage`.
 */
export function getMainShikiHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import("@shikijs/themes/github-light"),
        import("@shikijs/themes/github-dark"),
      ],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return highlighterPromise;
}
