/**
 * Monaco loader + worker configuration. Imported once (side-effect-only)
 * before any Monaco editor mounts.
 *
 * Three things to set up:
 *   1. `loader.config({ monaco })` — swaps `@monaco-editor/react`'s default
 *      CDN fetch for the locally-bundled `monaco-editor` package. Required
 *      for an offline desktop app.
 *   2. `globalThis.MonacoEnvironment.getWorker` — Monaco runs language
 *      services (TS, JSON, CSS, HTML) in dedicated web workers. Without
 *      this hook Monaco silently falls back to running them on the main
 *      thread, which throttles typing latency badly on larger files.
 *   3. Plugin-contributed grammar registration — fires `applyGrammarsToMonaco`
 *      so any `language-grammar` plugin's languages are registered with
 *      Monaco and Shiki tokens are bound before the first editor mounts.
 *
 * Vite resolves `?worker` queries into bundled web-worker scripts, so each
 * worker becomes a code-split chunk loaded only when its language activates.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { applyGrammarsToMonaco } from "../../utils/grammarRegistry";

// Monaco reads `globalThis.MonacoEnvironment.getWorker` whenever it needs
// to instantiate a language-service worker — that happens lazily, when an
// editor first activates a language with a worker (TS/JSON/CSS/HTML). The
// hook therefore needs to be in place before the editor mounts, which is
// why this file is imported only via the lazy MonacoEditor entry point.
//
// The label argument identifies which language service Monaco wants a
// worker for; everything else (the bare editor, plain-text, languages
// without a dedicated service) goes through `editor.worker`.
declare global {
  // eslint-disable-next-line no-var
  var MonacoEnvironment: monaco.Environment | undefined;
}

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

// Register plugin-contributed languages and bind Shiki tokenization.
// Awaits the grammar registry bootstrap internally — safe to call
// before main.tsx finishes its own bootstrap (idempotent + race-free).
// Any failure is logged but never thrown; an empty registry is a
// no-op so users without grammar plugins pay only the bootstrap call.
void applyGrammarsToMonaco(monaco);

export { monaco };
