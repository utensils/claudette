import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { AnsiUp } from "ansi_up";

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

// Shared rehype plugin list (stable reference avoids re-creating on every render)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REHYPE_PLUGINS: any[] = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
  rehypeHighlight,
];
export const REMARK_PLUGINS = [remarkGfm];
