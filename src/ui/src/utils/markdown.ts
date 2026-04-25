import React, { createElement, useContext, useEffect, useMemo, useReducer } from "react";
import type { PluggableList } from "unified";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { AnsiUp } from "ansi_up";
import { openUrl } from "../services/tauri";
import { CodeBlock } from "../components/chat/CodeBlock";
import { StreamingContext } from "../components/chat/StreamingContext";
import { getCachedHighlight, highlightCode } from "./highlight";

// Shared AnsiUp instance for converting ANSI escape sequences to HTML.
const ansiUp = new AnsiUp();
ansiUp.use_classes = false;

/** Convert ANSI escape codes in text to HTML span tags. */
export function ansiToHtml(text: string): string {
  if (!text.includes("\x1b")) return text;
  return ansiUp.ansi_to_html(text);
}

/**
 * Build callout header HTML, splitting a leading icon from the label text.
 * e.g. "★ Insight" → icon span + "Insight", "Warning" → just "Warning"
 */
function calloutHeader(rawLabel: string): string {
  const label = rawLabel.trim();
  const match = label.match(/^(\S)\s+(.*)/);
  if (match) {
    return `<span class="cc-callout-icon">${match[1]}</span> ${match[2]}`;
  }
  return label;
}

/**
 * Pre-process Claude Code's decorative callout blocks into styled HTML.
 * Claude outputs patterns like:
 *   `★ Insight ─────────────────────────────────────`
 *   [content]
 *   `─────────────────────────────────────────────────`
 *
 * These look great in a terminal but render as inline <code> in markdown.
 * Convert them to block-level HTML elements that react-markdown + rehype-raw
 * will pass through as styled callout blocks.
 */
export function preprocessCallouts(text: string): string {
  // Full callout blocks (backtick-wrapped): `Label ───` ... content ... `───`
  // [^─`] matches any character that isn't a dash or backtick — captures the label.
  text = text.replace(
    /`([^─`]+?)─{3,}`([\s\S]*?)`─{5,}`/g,
    (_m, label: string, content: string) =>
      `\n\n<div class="cc-callout"><div class="cc-callout-header">${calloutHeader(label)}</div>\n\n${content.trim()}\n\n</div>\n\n`,
  );

  // Full callout blocks (no backticks, standalone lines)
  text = text.replace(
    /^([^─\n]+?)─{3,}\s*$([\s\S]*?)^─{5,}\s*$/gm,
    (_m, label: string, content: string) =>
      `\n\n<div class="cc-callout"><div class="cc-callout-header">${calloutHeader(label)}</div>\n\n${content.trim()}\n\n</div>\n\n`,
  );

  // Leftover unmatched backtick-wrapped headers (no closing rule found)
  text = text.replace(
    /`([^─`]+?)─{3,}`/g,
    (_m, label: string) =>
      `\n\n<div class="cc-callout-header">${calloutHeader(label)}</div>\n\n`,
  );

  // Leftover unmatched backtick-wrapped horizontal rules
  text = text.replace(
    /`─{5,}`/g,
    '\n\n<hr class="cc-callout-rule" />\n\n',
  );

  return text;
}

/** Full pre-processing pipeline for assistant message content. */
export function preprocessContent(text: string): string {
  return preprocessCallouts(ansiToHtml(text));
}

// Sanitization schema: allow standard markdown HTML + our callout elements.
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div", "span", "hr",
  ],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    hr: [...(defaultSchema.attributes?.hr ?? []), "className"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "class"],
  },
};

// Shared plugin lists (stable references avoid re-creating on every render).
// Highlighting is no longer part of the plugin pipeline — it runs in a Web
// Worker off the main thread, dispatched from the `code` component override
// below once the surrounding subtree is no longer streaming.
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
];
export const REMARK_PLUGINS: PluggableList = [remarkGfm];

// Schemes that should open in the system browser rather than navigate the webview.
export const EXTERNAL_SCHEMES = /^https?:|^mailto:/i;

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  return "";
}

interface HighlightedCodeProps {
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

/**
 * Delay (ms) before dispatching a streaming code block to the worker. Only
 * blocks whose source text is stable for at least this long get highlighted
 * mid-stream. The actively-streaming (last) block changes per typewriter tick,
 * so its debounce timer keeps resetting and no wasted work hits the worker;
 * earlier blocks (closing-fence already written) become stable and highlight.
 */
const STREAMING_DEBOUNCE_MS = 120;

/**
 * Markdown `<code>` override. Inline code (no `language-*` class) renders as
 * a plain `<code>`. Fenced blocks read the highlight cache on every render —
 * a hit immediately upgrades to the highlighted spans; a miss schedules a
 * worker dispatch (debounced while streaming) and force-renders once the
 * worker resolves. The cache is keyed on `(lang, code)`, so changing `code`
 * during a stream produces a fresh lookup; React's reconciliation reuses the
 * same component instance, but the per-render cache read keeps the displayed
 * tokens in sync with the displayed text.
 */
export function HighlightedCode({
  className,
  children,
  ...props
}: HighlightedCodeProps): React.ReactElement {
  // Capture the full fence info string (up to whitespace), not just the
  // [\w-]+ subset. Supported languages with non-word characters in their
  // canonical names (e.g. `c++`) need the full token so the worker's
  // LANG_ALIASES table can normalize them; otherwise a `c++` fence
  // collapses to `c` and gets highlighted as plain C.
  const lang = typeof className === "string"
    ? (className.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? null)
    : null;
  const isStreaming = useContext(StreamingContext);
  // Memoize so re-renders that don't change `children` skip the recursive walk
  // and keep `code`'s identity stable — the highlight effect's deps then no
  // longer fire spuriously, so we don't enqueue redundant worker dispatches.
  const code = useMemo(
    () => (lang ? extractText(children) : ""),
    [lang, children],
  );
  const cached = lang ? getCachedHighlight(code, lang) : null;
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!lang) return;
    if (cached != null) return;
    let cancelled = false;

    if (isStreaming) {
      // Stream-time: debounce so RAF-driven `code` changes on the active
      // block reset the timer and never reach the worker. Stable blocks
      // settle within STREAMING_DEBOUNCE_MS and dispatch once.
      const timer = setTimeout(() => {
        void highlightCode(code, lang).then((result) => {
          if (!cancelled && result != null) forceUpdate();
        });
      }, STREAMING_DEBOUNCE_MS);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // Outside streaming (workspace switch, completed message render): skip
    // the setTimeout entirely. The browser's 4–15ms clamp on `setTimeout(0)`
    // would otherwise add visible latency to every code block on every
    // workspace mount before any postMessage is queued.
    void highlightCode(code, lang).then((result) => {
      if (!cancelled && result != null) forceUpdate();
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, isStreaming, cached]);

  if (lang && cached != null) {
    return createElement("code", {
      ...props,
      className,
      dangerouslySetInnerHTML: { __html: cached },
    });
  }
  if (lang) {
    // Render the extracted text with the trailing newline that
    // react-markdown emits before the closing fence stripped — otherwise
    // mid-stream blocks (cache miss) and the brief window before the
    // worker resolves show a phantom blank/selection line at the bottom.
    // The cache key already trims (see highlight.ts), so this only
    // affects the displayed text path.
    return createElement(
      "code",
      { ...props, className },
      code.replace(/\n+$/, ""),
    );
  }
  return createElement("code", { ...props, className }, children);
}

// Override <a> to open external links in the system browser instead of navigating the webview.
export const MARKDOWN_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a: ({ node, href, children, ...props }) =>
    createElement(
      "a",
      {
        ...props,
        href,
        onClick: (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (href && EXTERNAL_SCHEMES.test(href)) {
            e.preventDefault();
            void openUrl(href).catch((err) =>
              console.error("Failed to open URL:", href, err),
            );
          }
        },
      },
      children,
    ),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  pre: ({ node, children, ...props }) =>
    createElement(CodeBlock, props, children),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  code: ({ node, ...props }) => createElement(HighlightedCode, props),
};
