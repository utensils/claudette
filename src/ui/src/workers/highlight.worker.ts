/**
 * Shiki syntax-highlighting worker.
 *
 * Holds a single Shiki highlighter loaded with `github-light` + `github-dark`
 * themes. Grammars are loaded on demand via the fine-grained `@shikijs/langs/*`
 * dynamic imports below — only languages actually requested at runtime are
 * fetched, and Vite splits each into its own chunk.
 *
 * Wire protocol:
 *   in:  { id: number, code: string, lang: string }
 *   out: { id: number, html: string | null }
 *
 * `html` is the inner-HTML of Shiki's `<code>` element (no `<pre>` wrapper).
 * `null` indicates a hard failure; the main thread should fall back to plain
 * rendering. Output is structurally validated before serialization (only
 * `span` elements with `class`/`style` attributes plus text nodes are
 * permitted) — defense in depth for `dangerouslySetInnerHTML` on the consumer.
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

self.addEventListener(
  "message",
  (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
    const { id, code, lang } = e.data;
    void highlight(code, lang).then((html) => {
      (self as unknown as Worker).postMessage({ id, html });
    });
  },
);
