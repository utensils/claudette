/**
 * Claude Code's decorative callout blocks → styled block-level HTML.
 *
 * Claude emits these in two spellings. Inline-backtick, which is what the
 * output-style contract asks for:
 *
 *   `★ Insight ─────────────────────────────────────`
 *   [content]
 *   `─────────────────────────────────────────────────`
 *
 * …and bare lines with no backticks at all. Both look great in a terminal but
 * render as inline `<code>` (or as nothing at all) in markdown, so we rewrite
 * them into `<div class="cc-callout">` blocks that react-markdown + rehype-raw
 * pass through and `MessageMarkdown.module.css` styles.
 *
 * This is a text-level pass that runs *before* the markdown parser, which
 * means it has to do a slice of the parser's job itself: recognise the regions
 * where markdown syntax is inert. Without that, the bare-lines pattern happily
 * fires inside a fenced code block, the fence survives the rewrite, and the
 * reader gets a code box full of raw `<div class="cc-callout">` source.
 * `splitFences` carves the text into code / non-code segments so the rewrite
 * only ever touches prose.
 *
 * Models also sometimes wrap the whole callout in a bare fence — presumably to
 * protect the box-drawing characters from reflowing. `unwrapFencedCallout`
 * recognises that shape and promotes it to a real callout, so an insight
 * renders the same way regardless of which spelling the model reached for.
 */

/** Split a leading single-character icon off the label, e.g. "★ Insight". */
function calloutHeader(rawLabel: string): string {
  const label = rawLabel.trim();
  const match = label.match(/^(\S)\s+(.*)/);
  if (match) {
    return `<span class="cc-callout-icon">${match[1]}</span> ${match[2]}`;
  }
  return label;
}

/** The block-level HTML a matched callout becomes. */
function calloutHtml(label: string, content: string): string {
  return `\n\n<div class="cc-callout"><div class="cc-callout-header">${calloutHeader(label)}</div>\n\n${content.trim()}\n\n</div>\n\n`;
}

/**
 * Rewrite callout syntax within a single non-code segment.
 *
 * Kept as sequential `String.replace` passes (rather than one grammar) because
 * each pass handles a distinct degradation: complete blocks first, then the
 * orphaned header / rule fragments that a truncated or interrupted stream
 * leaves behind.
 */
function rewriteCallouts(text: string): string {
  // Full callout blocks (backtick-wrapped): `Label ───` ... content ... `───`
  // [^─`] matches any character that isn't a dash or backtick — captures the label.
  text = text.replace(
    /`([^─`]+?)─{3,}`([\s\S]*?)`─{5,}`/g,
    (_m, label: string, content: string) => calloutHtml(label, content),
  );

  // Full callout blocks (no backticks, standalone lines). The leading
  // lookahead keeps this off indented code blocks: under CommonMark a line
  // indented four or more spaces is code, not a paragraph, so a rule drawn
  // that far in is decoration inside a code sample rather than a callout.
  text = text.replace(
    /^(?! {4}|\t)([^─\n]+?)─{3,}\s*$([\s\S]*?)^─{5,}\s*$/gm,
    (_m, label: string, content: string) => calloutHtml(label, content),
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

type Segment =
  | { kind: "text"; lines: string[] }
  | {
      kind: "fence";
      open: string;
      /** Info string after the opening marker, trimmed ("" for a bare fence). */
      info: string;
      body: string[];
      /** null when the fence is never closed (runs to end of input). */
      close: string | null;
    };

/** Opening fence: up to three spaces of indent, then 3+ backticks or tildes. */
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Partition `text` into alternating prose and fenced-code segments, following
 * CommonMark's fence rules closely enough for chat content: a closing fence
 * uses the same character, is at least as long as the opener, and carries
 * nothing but trailing whitespace. Every input line lands in exactly one
 * segment, so joining the rendered segments with "\n" reproduces the original
 * text when nothing matches.
 */
function splitFences(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let buf: string[] = [];

  const flushText = () => {
    if (buf.length > 0) {
      segments.push({ kind: "text", lines: buf });
      buf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN_RE);
    // A backtick fence's info string may not itself contain a backtick —
    // otherwise `` `foo` `` at the start of a line would read as a fence.
    const isFence =
      open != null && !(open[2].startsWith("`") && open[3].includes("`"));

    if (!isFence || open == null) {
      buf.push(lines[i]);
      i += 1;
      continue;
    }

    flushText();
    const marker = open[2];
    const closeRe = new RegExp(
      `^ {0,3}[${marker[0]}]{${marker.length},}[ \\t]*$`,
    );
    const openLine = lines[i];
    const body: string[] = [];
    let close: string | null = null;
    i += 1;
    while (i < lines.length) {
      if (closeRe.test(lines[i])) {
        close = lines[i];
        i += 1;
        break;
      }
      body.push(lines[i]);
      i += 1;
    }
    segments.push({ kind: "fence", open: openLine, info: open[3].trim(), body, close });
  }

  flushText();
  return segments;
}

/** A fence body that is nothing but a callout: header rule, content, closing rule. */
const FENCED_CALLOUT_RE =
  /^([^─\n]+?)─{3,}[ \t]*\n([\s\S]*)\n[ \t]*─{5,}[ \t]*$/;

/**
 * Promote a fence whose entire body is a callout back into a real callout.
 *
 * Deliberately conservative: only bare fences qualify. A fence tagged with a
 * language (```text, ```js) is a code sample the author chose to show
 * verbatim, and unwrapping it would destroy content rather than style it.
 */
function unwrapFencedCallout(seg: Extract<Segment, { kind: "fence" }>): string | null {
  if (seg.info !== "") return null;
  if (seg.close == null) return null;
  const match = seg.body.join("\n").trim().match(FENCED_CALLOUT_RE);
  if (!match) return null;
  if (!match[1].trim()) return null;
  return calloutHtml(match[1], match[2]);
}

function renderSegment(seg: Segment): string {
  if (seg.kind === "text") return rewriteCallouts(seg.lines.join("\n"));
  const unwrapped = unwrapFencedCallout(seg);
  if (unwrapped != null) return unwrapped;
  const parts = [seg.open, ...seg.body];
  if (seg.close != null) parts.push(seg.close);
  return parts.join("\n");
}

/**
 * Pre-process Claude Code's decorative callout blocks into styled HTML,
 * leaving the contents of fenced code blocks alone.
 */
export function preprocessCallouts(text: string): string {
  return splitFences(text).map(renderSegment).join("\n");
}
