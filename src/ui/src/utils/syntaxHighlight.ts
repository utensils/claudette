import hljs from "highlight.js/lib/common";

// Extension → highlight.js language name. Only languages bundled in
// highlight.js/lib/common are usable here; unknown extensions fall back to
// plain text rendering.
const EXT_TO_LANGUAGE: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  diff: "diff",
  patch: "diff",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  makefile: "makefile",
  mk: "makefile",
  pl: "perl",
  pm: "perl",
  php: "php",
  py: "python",
  pyi: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  vue: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
};

export function languageForFile(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();

  const filenameMatch = FILENAME_TO_LANGUAGE[lower];
  if (filenameMatch) return filenameMatch;

  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);
  return EXT_TO_LANGUAGE[ext] ?? null;
}

/** Highlight a single line of source. Returns HTML with hljs-* class spans,
 *  or null if the language is unknown. The caller should render null as plain
 *  text. Multi-line constructs (block comments, template literals) may be
 *  mis-tokenized because each line is highlighted in isolation. */
export function highlightLine(
  content: string,
  language: string | null,
): string | null {
  if (!language || !content) return null;
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
