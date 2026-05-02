/**
 * Map a file path to a Shiki/highlight language id. Used by the diff
 * viewer (highlighting per-line code) and any other surface that needs
 * the language hint without owning the grammar registry.
 *
 * Resolution order (most specific → most general):
 *   1. Plugin-contributed filenames (e.g. `Dockerfile` → "dockerfile")
 *   2. Built-in filename mappings
 *   3. Plugin-contributed extensions (longest match wins)
 *   4. Built-in extension mappings
 *
 * Returns `null` when no language matches; callers should render plain
 * text. The returned id is the same one accepted by the Shiki worker
 * (`utils/highlight.ts`), so passing it back through `highlightCode`
 * Just Works.
 */

import { getRegisteredPluginLanguages } from "./grammarRegistry";

/**
 * Built-in extension → Shiki language id. Mirrors the keys in the
 * worker's `LANG_LOADERS` map (and its `LANG_ALIASES`). Keep in sync
 * when adding a new built-in language.
 */
const BUILTIN_EXT_TO_LANG: Record<string, string> = {
  bash: "bash",
  sh: "shell",
  zsh: "shell",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  css: "css",
  scss: "css",
  less: "css",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  html: "html",
  htm: "html",
  hs: "haskell",
  ini: "ini",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  nix: "nix",
  php: "php",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
};

/** Built-in filename → Shiki language id (for files without an extension). */
const BUILTIN_FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
};

export function languageForFile(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = (path.split("/").pop() ?? path).toLowerCase();

  // Plugin-contributed filenames take priority over built-ins so a
  // plugin can refine an existing mapping (e.g. ship a more accurate
  // Dockerfile grammar). Then built-in filenames, then extensions.
  const pluginLanguages = getRegisteredPluginLanguages();

  for (const lang of pluginLanguages) {
    if (lang.filenames.some((f) => f.toLowerCase() === base)) return lang.id;
  }

  const builtinFilename = BUILTIN_FILENAME_TO_LANG[base];
  if (builtinFilename) return builtinFilename;

  // Extension match — strip up to the last dot and look up.
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx < 0) return null;
  const extWithDot = base.slice(dotIdx); // includes the dot, matches manifest format
  const ext = base.slice(dotIdx + 1);

  for (const lang of pluginLanguages) {
    if (lang.extensions.some((e) => e.toLowerCase() === extWithDot)) {
      return lang.id;
    }
  }

  return BUILTIN_EXT_TO_LANG[ext] ?? null;
}
