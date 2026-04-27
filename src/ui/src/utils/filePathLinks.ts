/**
 * Detect absolute file paths inside a plain-text string so a markdown
 * post-processor can wrap them in clickable links. The link target uses
 * a custom `claudettepath:` URI so the markdown `<a>` override knows to
 * route the click into a Tauri command instead of treating it as a web
 * URL — and so rehype-sanitize doesn't strip it as an unsafe protocol
 * (we extend the allowed-scheme list in `markdown.ts`).
 *
 * Recognized:
 *  - POSIX absolute      `/tmp/foo.csv`, `/Users/.../bar.png`
 *  - POSIX home          `~/Downloads/foo.csv`
 *  - Windows drive       `C:\Users\foo\bar.csv`, `C:/Users/foo/bar.csv`
 *  - Windows UNC         `\\server\share\file.txt`
 *
 * Deliberately ignored:
 *  - Bare relative paths (`foo/bar.csv`) — too ambiguous, false-positives
 *    with sentence fragments, and we have no anchor to resolve them
 *    against on the host side.
 *  - URLs (`https://...`) — the leading `://` lookbehind keeps the regex
 *    from matching the `/example.com/...` substring inside one.
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
 * Negative lookbehind on `[\w:.\\\/-]` blocks matches that start in the
 * middle of an existing path or URL (e.g. `https://x.com/y` — the `/y`
 * is preceded by `m`, fails). This is the cheapest way to avoid mangling
 * URLs without a separate URL parser.
 */
const PATH_REGEX =
  /(?<![\w:.\\/\-])(?:[A-Za-z]:[\\/][^\s<>"|*?]+|\\\\[^\s<>"|*?\\/]+\\[^\s<>"|*?\\/]+(?:\\[^\s<>"|*?\\/]+)*|~?\/[^\s<>"|*?]+)/g;

/**
 * Sentence-final characters that tend to follow a path in prose but are
 * almost never part of a real filename. Stripped from the tail of every
 * match. Backticks are included so a path written like `` `…` `` doesn't
 * absorb the closing backtick when it appears inside inline-code-adjacent
 * prose. */
const TRAILING_PUNCT_REGEX = /[.,;:!?)\]'"`]+$/;

/** Real paths have at least one separator inside the body, not just the
 *  prefix. `/a` is too short to be a useful match. */
const MIN_PATH_LENGTH = 3;

export function detectFilePaths(text: string): FilePathMatch[] {
  const matches: FilePathMatch[] = [];
  for (const m of text.matchAll(PATH_REGEX)) {
    if (m.index === undefined) continue;
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
