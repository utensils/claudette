import React, { createElement } from "react";
import type { PluggableList } from "unified";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { AnsiUp } from "ansi_up";
import { openUrl } from "../services/tauri";
import { CodeBlock } from "../components/chat/CodeBlock";

// Shared AnsiUp instance for converting ANSI escape sequences to HTML.
const ansiUp = new AnsiUp();
ansiUp.use_classes = false;

/** Convert ANSI escape codes in text to HTML span tags. */
export function ansiToHtml(text: string): string {
  if (!text.includes("\x1b") && !text.includes("\u001b")) return text;
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

// Shared plugin lists (stable references avoid re-creating on every render)
export const REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeHighlight,
];
export const REMARK_PLUGINS: PluggableList = [remarkGfm];

// Schemes that should open in the system browser rather than navigate the webview.
export const EXTERNAL_SCHEMES = /^https?:|^mailto:/i;

/**
 * Trim all trailing newlines from the last text-node child of a code element.
 * rehype-highlight preserves the source `\n` before the closing fence; those
 * phantom newlines paint extra selection lines below the visible code.
 */
export function trimTrailingCodeNewline(children: React.ReactNode): React.ReactNode {
  const arr = React.Children.toArray(children);
  if (arr.length === 0) return children;
  const last = arr[arr.length - 1];
  if (typeof last !== "string") return children;
  const trimmed = last.replace(/\n+$/, "");
  if (trimmed === last) return children;
  if (trimmed === "") return arr.slice(0, -1);
  return [...arr.slice(0, -1), trimmed];
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
  code: ({ node, className, children, ...props }) => {
    const isFenced =
      typeof className === "string" && /\b(?:hljs|language-)/.test(className);
    return createElement(
      "code",
      { ...props, className },
      isFenced ? trimTrailingCodeNewline(children) : children,
    );
  },
};
