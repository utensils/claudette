/**
 * Pure logic for the in-chat CLI invocation banner.
 *
 * The Rust side (see `src/agent/args.rs::format_redacted_invocation`) emits a
 * single line of POSIX-shell-quoted argv. We tokenize that line, identify the
 * binary path, group flags with their (optional) values, and locate the
 * trailing `<prompt>` placeholder. The structured form lets the banner render
 * each flag on its own row instead of as one ugly horizontally-scrolling pre.
 */

export interface ParsedFlag {
  /** The flag name including its leading dashes — e.g. `--model`. */
  name: string;
  /** Value following the flag, or null for boolean / standalone flags. */
  value: string | null;
}

export interface ParsedInvocation {
  /** Display name of the binary (last path segment of the original argv[0]). */
  binary: string;
  /** Original, fully-qualified binary path as emitted by the backend. */
  binaryFullPath: string;
  /** Ordered flag list. */
  flags: ParsedFlag[];
  /** Trailing positional, typically `<prompt>` or null when absent. */
  prompt: string | null;
  /** The original raw invocation string, preserved verbatim for copy. */
  raw: string;
}

export function shouldShowBanner(invocation: string | null): boolean {
  return typeof invocation === "string" && invocation.trim().length > 0;
}

/**
 * POSIX-ish shell tokenizer. The backend only ever emits double-/single-quoted
 * strings or unquoted bare words (see `shell_quote` in `src/agent/args.rs`),
 * so we don't need to handle environment expansion, command substitution, or
 * here-docs. We do honor backslash-escapes inside double quotes, and the
 * `'\''` idiom the Rust backend emits to embed a literal single quote inside
 * a single-quoted span — which decomposes to "close single quote, escaped
 * single quote, open single quote" and only round-trips correctly if `\'`
 * outside quotes is treated as a literal `'` (POSIX semantics).
 */
export function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  const pushToken = () => {
    if (hasContent) {
      tokens.push(buf);
      buf = "";
      hasContent = false;
    }
  };

  while (i < line.length) {
    const ch = line[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        i += 1;
        continue;
      }
      buf += ch;
      hasContent = true;
      i += 1;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && i + 1 < line.length) {
        const next = line[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          buf += next;
        } else {
          buf += ch + next;
        }
        hasContent = true;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        i += 1;
        continue;
      }
      buf += ch;
      hasContent = true;
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t") {
      pushToken();
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      // POSIX: outside quotes, backslash escapes the following character to
      // its literal value. Critically, this is what makes the backend's
      // `'\''` idiom round-trip correctly: the close-quote/escape-quote/
      // open-quote sandwich emits a literal `'` between two single-quoted
      // spans that get concatenated into a single token.
      buf += line[i + 1];
      hasContent = true;
      i += 2;
      continue;
    }
    buf += ch;
    hasContent = true;
    i += 1;
  }
  pushToken();
  return tokens;
}

function looksLikeFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function basename(path: string): string {
  // Handle both POSIX and Windows-style separators because dev users live
  // on both. Strip a trailing separator before basename so `C:/foo/` →
  // `foo`, not empty string.
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Parse a redacted invocation string into its structured form. Returns null
 * when the line is unusable (no binary token).
 */
export function parseInvocation(invocation: string): ParsedInvocation | null {
  const tokens = tokenizeShellLine(invocation);
  if (tokens.length === 0) return null;

  const binaryFullPath = tokens[0];
  const binary = basename(binaryFullPath) || binaryFullPath;

  const flags: ParsedFlag[] = [];
  let prompt: string | null = null;

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];

    // Trailing `<prompt>` marker (or any non-flag positional) closes the list.
    if (!looksLikeFlag(token)) {
      // Only the very last token is a positional in well-formed input. If
      // there are tokens after a non-flag, treat them as additional
      // positionals concatenated into `prompt` so we don't silently drop them.
      const rest = tokens.slice(i).join(" ");
      prompt = rest;
      break;
    }

    // Inline `--flag=value` form — split on the first `=`.
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 2) {
      flags.push({ name: token.slice(0, eq), value: token.slice(eq + 1) });
      i += 1;
      continue;
    }

    const next = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (next !== null && !looksLikeFlag(next)) {
      // Look one more ahead: if the token after `next` is also non-flag and
      // we're at the tail, `next` was a value and the tail is the prompt.
      flags.push({ name: token, value: next });
      i += 2;
      continue;
    }
    // Boolean flag (or last token) — no value.
    flags.push({ name: token, value: null });
    i += 1;
  }

  return { binary, binaryFullPath, flags, prompt, raw: invocation };
}

/**
 * Truncate a long opaque value (UUID, hash, path) to a head…tail form so the
 * collapsed banner stays scannable. Short values pass through untouched.
 */
export function truncateMiddle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Build the one-line summary shown in the collapsed banner.
 *
 * Shape: `<binary> · <highlight values…> · <N flag(s)>`. The highlighted
 * flags are picked from `SUMMARY_HIGHLIGHT_FLAGS` in order, and any value
 * that looks like a redactor placeholder (`<…>` — the Rust side emits
 * `<redacted>` and `<prompt>`) is dropped so the collapsed banner never
 * shows opaque sentinels in place of real values.
 *
 * The flag count comes from `parsed.flags` only — the trailing positional
 * (`<prompt>`) is parsed separately and never enters the count.
 */
const SUMMARY_HIGHLIGHT_FLAGS = ["--model", "--session-id"] as const;

function isPlaceholderValue(value: string): boolean {
  return value.startsWith("<") && value.endsWith(">");
}

export function summarizeInvocation(parsed: ParsedInvocation): string {
  const parts: string[] = [parsed.binary];

  for (const name of SUMMARY_HIGHLIGHT_FLAGS) {
    const flag = parsed.flags.find((f) => f.name === name);
    if (!flag || flag.value === null) continue;
    if (isPlaceholderValue(flag.value)) continue;
    parts.push(truncateMiddle(flag.value));
  }

  const flagCount = parsed.flags.length;
  if (flagCount > 0) {
    parts.push(`${flagCount} flag${flagCount === 1 ? "" : "s"}`);
  }

  return parts.join(" · ");
}
