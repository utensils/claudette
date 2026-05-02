/**
 * Shiki syntax-highlighting worker.
 *
 * Holds a single Shiki highlighter loaded with `github-light` + `github-dark`
 * themes. Grammars are loaded on demand via the fine-grained `@shikijs/langs/*`
 * dynamic imports below — only languages actually requested at runtime are
 * fetched, and Vite splits each into its own chunk. Plugin-contributed
 * grammars are registered ahead of time via `register-grammar` messages
 * (see [[IncomingMessage]] below), making them indistinguishable from the
 * built-in loaders to the rest of the pipeline.
 *
 * Wire protocol:
 *   in (highlight):  { id: number, code: string, lang: string }
 *   in (register):   { type: "register-grammar", lang: string, grammar: unknown }
 *   out:             { id: number, html: string | null }
 *
 * `html` is the inner-HTML of Shiki's `<code>` element (no `<pre>` wrapper).
 * `null` indicates a hard failure; the main thread should fall back to plain
 * rendering. Output is structurally validated before serialization (only
 * `span` elements with `class`/`style` attributes plus text nodes are
 * permitted) — defense in depth for `dangerouslySetInnerHTML` on the consumer.
 *
 * `register-grammar` is fire-and-forget — the main thread is expected to
 * issue all registrations during bootstrap before any highlight requests
 * for the registered languages, so there's no need for a confirmation
 * response.
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { toHtml } from "hast-util-to-html";
import type { Element, ElementContent, Root } from "hast";

// Each entry imports a single grammar. Vite code-splits each into its own
// chunk; only languages actually used are downloaded.
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  haskell: () => import("@shikijs/langs/haskell"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  nix: () => import("@shikijs/langs/nix"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scala: () => import("@shikijs/langs/scala"),
  shell: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  zig: () => import("@shikijs/langs/zig"),
};

// Common aliases users (and agents) write in fence info strings.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "bash",
  zsh: "shell",
  shellscript: "shell",
  yml: "yaml",
  md: "markdown",
  cs: "csharp",
  "c++": "cpp",
  cxx: "cpp",
  golang: "go",
  kt: "kotlin",
  htm: "html",
  makefile: "make",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const failedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
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

async function ensureLang(
  hl: HighlighterCore,
  lang: string,
): Promise<string> {
  const canonical = LANG_ALIASES[lang] ?? lang;
  if (loadedLangs.has(canonical)) return canonical;
  if (failedLangs.has(canonical)) return "text";
  const loader = LANG_LOADERS[canonical];
  if (!loader) {
    failedLangs.add(canonical);
    return "text";
  }
  try {
    const mod = (await loader()) as { default: unknown };
    await hl.loadLanguage(mod.default as never);
    loadedLangs.add(canonical);
    return canonical;
  } catch {
    failedLangs.add(canonical);
    return "text";
  }
}

/**
 * Load a plugin-contributed TextMate grammar into the highlighter.
 * Idempotent — re-registering the same `lang` is harmless (Shiki's
 * `loadLanguage` overwrites the existing grammar). On success the
 * lang id is added to `loadedLangs` so subsequent `ensureLang` calls
 * short-circuit without consulting the built-in `LANG_LOADERS` map.
 *
 * Errors are caught and logged but never re-thrown: a malformed
 * grammar must not poison the worker for unrelated languages. A
 * follow-up highlight request for the failed lang falls through to
 * the regular `ensureLang` path which will mark it failed and render
 * as plain text.
 */
async function registerGrammar(lang: string, grammar: unknown): Promise<void> {
  try {
    const hl = await getHighlighter();
    await hl.loadLanguage(grammar as never);
    loadedLangs.add(lang);
    failedLangs.delete(lang);
  } catch (e) {
    console.warn(`[shiki worker] failed to register grammar for "${lang}":`, e);
  }
}

/**
 * Validate that an element subtree contains only what Shiki is supposed to
 * emit: `span` elements with at most `class`/`className`/`style`
 * properties, plus text nodes. Anything else (including raw HTML embedded
 * via prompt-injected code text) means we refuse to serialize. Both `class`
 * and `className` are accepted because hast nodes from different sources
 * use either spelling.
 */
const ALLOWED_PROPS = new Set(["class", "className", "style"]);

function isStructurallySafe(node: ElementContent): boolean {
  if (node.type === "text") return true;
  if (node.type !== "element") return false;
  const el = node as Element;
  if (el.tagName !== "span") return false;
  const props = el.properties ?? {};
  for (const key of Object.keys(props)) {
    if (!ALLOWED_PROPS.has(key)) return false;
  }
  return el.children.every(isStructurallySafe);
}

function findCodeElement(root: Root): Element | null {
  for (const child of root.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "pre") {
      for (const grand of child.children) {
        if (grand.type === "element" && grand.tagName === "code") {
          return grand;
        }
      }
    }
  }
  return null;
}

async function highlight(code: string, lang: string): Promise<string | null> {
  try {
    const hl = await getHighlighter();
    const useLang = lang ? await ensureLang(hl, lang) : "text";
    const root = hl.codeToHast(code, {
      lang: useLang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    const codeEl = findCodeElement(root);
    if (!codeEl) return null;
    if (!codeEl.children.every(isStructurallySafe)) return null;
    return toHtml({ type: "root", children: codeEl.children });
  } catch {
    return null;
  }
}

/**
 * Tagged-union message protocol. `register-grammar` is the only
 * tagged variant; highlight requests stay untagged for backwards
 * compatibility with existing callers that send `{ id, code, lang }`
 * directly. The "in" type guard below distinguishes them at runtime.
 */
type IncomingMessage =
  | { type: "register-grammar"; lang: string; grammar: unknown }
  | { id: number; code: string; lang: string };

self.addEventListener(
  "message",
  (e: MessageEvent<IncomingMessage>) => {
    const data = e.data;
    if ("type" in data && data.type === "register-grammar") {
      void registerGrammar(data.lang, data.grammar);
      return;
    }
    if ("id" in data) {
      const { id, code, lang } = data;
      void highlight(code, lang).then((html) => {
        (self as unknown as Worker).postMessage({ id, html });
      });
    }
  },
);
