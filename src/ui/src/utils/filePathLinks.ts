/**
 * Detect file paths inside a plain-text string so a markdown
 * post-processor can wrap them in clickable links. The link target uses
 * a custom `claudettepath:` URI so the markdown `<a>` override knows to
 * route the click into the workspace file opener instead of treating it as
 * a web URL — and so rehype-sanitize doesn't strip it as an unsafe protocol
 * (we extend the allowed-scheme list in `markdown.ts`).
 *
 * Recognized:
 *  - POSIX absolute      `/tmp/foo.csv`, `/Users/.../bar.png`
 *  - POSIX home          `~/Downloads/foo.csv`
 *  - Windows drive       `C:\Users\foo\bar.csv`, `C:/Users/foo/bar.csv`
 *  - Windows UNC         `\\server\share\file.txt`
 *  - Relative files      `README.md`, `src/main.rs`, `package.json`
 *
 * Deliberately ignored:
 *  - URLs (`https://...`) — the leading `://` lookbehind keeps the regex
 *    from matching the `/example.com/...` substring inside one.
 *  - Domain-like prose (`example.com`) — common URL-ish hostnames are not
 *    workspace files.
 */

export interface FilePathMatch {
  /** Inclusive start offset in the source text (UTF-16 code units). */
  start: number;
  /** Exclusive end offset, after trailing punctuation has been trimmed. */
  end: number;
  /** The matched path with surrounding sentence punctuation stripped. */
  path: string;
}

/**
 * The path body uses `[^\s<>"|*?]` rather than a stricter set so:
 *  - paths with spaces would still split on whitespace (we don't try to
 *    handle quoted paths, by design — too ambiguous in prose)
 *  - shell metacharacters that can't appear in a filename on either
 *    POSIX or NTFS act as natural terminators
 *  - the regex stays compact enough to read
 *
 * The "must not be in the middle of an existing path or URL" rule
 * (e.g. `https://x.com/y` — the `/y` should not match) is enforced via
 * an explicit JS-side check on the preceding character below, NOT via
 * a regex lookbehind. WebKit on macOS 11 (our `minimumSystemVersion`)
 * ships JavaScriptCore without `RegExp` lookbehind support, so a
 * `(?<!…)` group throws a `SyntaxError` at module-eval time and breaks
 * markdown rendering across the entire chat surface. Lookbehind lands
 * in WebKit 16.4 (Safari 16.4, ~ macOS 13.3); until we bump the OS
 * floor we have to do this in code.
 */
const PATH_REGEX =
  /(?:[A-Za-z]:[\\/][^\s<>"|*?]+|\\\\[^\s<>"|*?\\/]+\\[^\s<>"|*?\\/]+(?:\\[^\s<>"|*?\\/]+)*|~?\/[^\s<>"|*?]+)/g;

const RELATIVE_FILE_REGEX =
  /(?:\.{1,2}[\\/])?(?:[A-Za-z0-9_$@.+-]+[\\/])*[A-Za-z0-9_$@.+-]+(?:\.[A-Za-z0-9][A-Za-z0-9+-]{0,15})+/g;

/**
 * Characters that, if they sit immediately before a regex match, indicate
 * the match started in the middle of an existing token (URL scheme tail,
 * another path, hyphenated word). Mirrors the old lookbehind's character
 * class: word chars, colon, dot, both slash kinds, hyphen.
 */
const FORBIDDEN_PREV_CHAR_REGEX = /[\w:.\\/@-]/;

/**
 * Sentence-final characters that tend to follow a path in prose but are
 * almost never part of a real filename. Stripped from the tail of every
 * match. Backticks are included so a path written like `` `…` `` doesn't
 * absorb the closing backtick when it appears inside inline-code-adjacent
 * prose. */
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]'"`]+$/;

/** Minimum-length heuristic for detected paths after trailing punctuation
 *  is stripped. This filters out very short matches like `/a` (which are
 *  almost always punctuation noise rather than real filenames) without
 *  enforcing the presence of an additional inner separator — that would
 *  reject legitimate two-segment paths like `/etc` or `~/foo`. */
const MIN_PATH_LENGTH = 3;

const COMMON_HOSTLIKE_EXTENSIONS = new Set([
  "app",
  "biz",
  "co",
  "com",
  "dev",
  "io",
  "net",
  "org",
]);

const KNOWN_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "clj",
  "cljs",
  "cmake",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "cu",
  "cxx",
  "dart",
  "diff",
  "dockerignore",
  "env",
  "erb",
  "fish",
  "go",
  "graphql",
  "h",
  "hpp",
  "hs",
  "html",
  "java",
  "jl",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "m",
  "md",
  "mdx",
  "mjs",
  "mm",
  "mts",
  "nix",
  "patch",
  "php",
  "pl",
  "plist",
  "proto",
  "py",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "tsx",
  "ts",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zig",
  "zsh",
]);

const KNOWN_FILENAMES = new Set([
  ".env",
  ".gitignore",
  ".npmrc",
  ".prettierrc",
  "cargo.lock",
  "cargo.toml",
  "dockerfile",
  "justfile",
  "makefile",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "readme",
  "readme.md",
  "tsconfig.json",
  "vite.config.ts",
  "yarn.lock",
]);

export function detectFilePaths(text: string): FilePathMatch[] {
  const matches: FilePathMatch[] = [];
  for (const m of text.matchAll(PATH_REGEX)) {
    if (m.index === undefined) continue;
    // Lookbehind-equivalent guard: skip matches that started in the
    // middle of another token. See PATH_REGEX comment for why this is
    // a JS check rather than a regex lookbehind.
    if (m.index > 0 && FORBIDDEN_PREV_CHAR_REGEX.test(text[m.index - 1])) {
      continue;
    }
    const raw = m[0];
    const stripped = raw.replace(TRAILING_PUNCT_REGEX, "");
    if (stripped.length < MIN_PATH_LENGTH) continue;
    matches.push({
      start: m.index,
      end: m.index + stripped.length,
      path: stripped,
    });
  }
  return matches;
}

export function isLikelyRelativeFileReference(value: string): boolean {
  const candidate = value.trim().replace(TRAILING_PUNCT_REGEX, "");
  if (!candidate || candidate.length < MIN_PATH_LENGTH) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return false;
  if (/^[\\/]|^[A-Za-z]:[\\/]/.test(candidate)) return false;
  if (candidate.includes("://") || candidate.includes("@")) return false;

  const normalized = candidate.replace(/\\/g, "/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return false;
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return false;
  }

  const basename = parts[parts.length - 1].toLowerCase();
  if (KNOWN_FILENAMES.has(basename)) return true;

  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  const ext = basename.slice(dot + 1);
  if (COMMON_HOSTLIKE_EXTENSIONS.has(ext) && parts.length === 1) return false;
  return KNOWN_FILE_EXTENSIONS.has(ext);
}

export function detectFileReferences(text: string): FilePathMatch[] {
  const absoluteMatches = detectFilePaths(text);
  const matches: FilePathMatch[] = [...absoluteMatches];

  for (const m of text.matchAll(RELATIVE_FILE_REGEX)) {
    if (m.index === undefined) continue;
    if (m.index > 0 && FORBIDDEN_PREV_CHAR_REGEX.test(text[m.index - 1])) {
      continue;
    }
    if (
      absoluteMatches.some(
        (absolute) => m.index! >= absolute.start && m.index! < absolute.end,
      )
    ) {
      continue;
    }

    const raw = m[0];
    const stripped = raw.replace(TRAILING_PUNCT_REGEX, "");
    if (!isLikelyRelativeFileReference(stripped)) continue;
    matches.push({
      start: m.index,
      end: m.index + stripped.length,
      path: stripped,
    });
  }

  return matches.sort((a, b) => a.start - b.start);
}

/** URI scheme used by the markdown autolinker to mark its synthesized
 *  `<a>` nodes. The MARKDOWN_COMPONENTS.a override looks for this prefix
 *  to route clicks into the Tauri `open_in_editor` command.
 *
 *  No hyphen on purpose — hast-util-sanitize's URL parser scans the
 *  scheme portion strictly and a `claudette-path:foo` URL was being
 *  emitted with an empty href in practice. A single-token scheme name
 *  matches the ABNF for `URI-scheme` and survives sanitization
 *  unconditionally once added to `protocols.href`. */
export const FILE_PATH_SCHEME = "claudettepath:";

export function encodeFilePathHref(path: string): string {
  // encodeURI keeps slashes/backslashes legible in the DOM (helpful for
  // debugging); only space and the few characters that genuinely break
  // a URI need escaping.
  return `${FILE_PATH_SCHEME}${encodeURI(path)}`;
}

export function decodeFilePathHref(href: string): string | null {
  if (!href.startsWith(FILE_PATH_SCHEME)) return null;
  const tail = href.slice(FILE_PATH_SCHEME.length);
  // `decodeURI` throws `URIError` on malformed percent-encoding (e.g. a
  // dangling `%` or invalid `%x` pair). A bad `claudettepath:` link in
  // assistant markdown shouldn't be able to crash the click handler or
  // the markdown render — fall back to the raw, undecoded tail so the
  // caller still has *something* to pass to `open_in_editor`. The
  // backend will surface its own error if the path doesn't exist.
  try {
    return decodeURI(tail);
  } catch {
    return tail;
  }
}
