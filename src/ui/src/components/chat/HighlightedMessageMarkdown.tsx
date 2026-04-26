import { memo, useLayoutEffect, useRef } from "react";
import { MessageMarkdown } from "./MessageMarkdown";

/**
 * Wraps `<MessageMarkdown>` and overlays `<mark class="cc-search-match">`
 * around every case-insensitive substring match of `query`, applied via a
 * post-render DOM walker on the wrapper element.
 *
 * The DOM-mutation path (rather than a render-time text split) is
 * deliberate: the markdown pipeline is heavily memoized — `MessageMarkdown`
 * caches its parse result keyed on `content`, the Shiki worker caches
 * highlighted code keyed on `(lang, code)`. Re-running react-markdown for
 * every keystroke would invalidate both. By layering highlights after the
 * markdown DOM is committed, the cached subtree stays mounted and the
 * highlight effect runs in O(visible-text) per keystroke.
 *
 * Code blocks are skipped so search highlights don't fragment Shiki's
 * tokenized DOM.
 */
const SEARCH_MARK_CLASS = "cc-search-match";

interface Props {
  content: string;
  query: string;
}

export const HighlightedMessageMarkdown = memo(function HighlightedMessageMarkdown({
  content,
  query,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-run on every (content, query) change. Body is idempotent: it first
  // strips any marks we previously added, then re-applies. We don't use a
  // cleanup function because cleanup runs *after* React reconciles the next
  // render, which is too late — by then the inner markdown subtree may have
  // already been rebuilt by react-markdown (when `content` changes) or
  // preserved verbatim (when only `query` changes). Running both passes
  // here keeps the wrapper in sync with the latest commit either way.
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    removeHighlights(root);
    if (query) applyHighlights(root, query);
  }, [content, query]);

  return (
    <div ref={containerRef} className="cc-highlight-wrap">
      <MessageMarkdown content={content} />
    </div>
  );
});

function applyHighlights(root: HTMLElement, query: string): void {
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return;
  const queryLength = lowerQuery.length;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text inside <code> / <pre> — those are syntax-highlighted by
      // Shiki and fragmenting the token spans would break colors.
      let p: Node | null = node.parentNode;
      while (p && p !== root) {
        const tag = (p as HTMLElement).tagName;
        if (tag === "CODE" || tag === "PRE") return NodeFilter.FILTER_REJECT;
        if ((p as HTMLElement).classList?.contains(SEARCH_MARK_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return node.nodeValue && node.nodeValue.length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  // Collect first to avoid mutating the tree mid-walk.
  const targets: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    targets.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of targets) {
    const text = textNode.nodeValue ?? "";
    const lower = text.toLowerCase();
    let from = 0;
    let idx = lower.indexOf(lowerQuery, from);
    if (idx === -1) continue;

    const fragment = document.createDocumentFragment();
    while (idx !== -1) {
      if (idx > from) {
        fragment.appendChild(document.createTextNode(text.slice(from, idx)));
      }
      const mark = document.createElement("mark");
      mark.className = SEARCH_MARK_CLASS;
      mark.textContent = text.slice(idx, idx + queryLength);
      fragment.appendChild(mark);
      from = idx + queryLength;
      idx = lower.indexOf(lowerQuery, from);
    }
    if (from < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(from)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

function removeHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${SEARCH_MARK_CLASS}`);
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    // Replace <mark>text</mark> with a single TextNode and merge with
    // adjacent siblings so the parent ends up indistinguishable from
    // before the highlight pass — react-markdown's reconciliation can
    // then reuse the same DOM on the next render.
    parent.replaceChild(
      document.createTextNode(mark.textContent ?? ""),
      mark,
    );
    parent.normalize();
  }
}
