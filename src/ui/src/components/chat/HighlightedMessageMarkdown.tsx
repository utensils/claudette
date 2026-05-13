import { memo, useLayoutEffect, useRef } from "react";
import { MessageMarkdown } from "./MessageMarkdown";
import { findAllRanges, nextSearchMatchId } from "../../utils/textSearch";

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
  onOpenFile?: (path: string) => boolean;
  resolveFilePath?: (path: string) => string | null;
}

export const HighlightedMessageMarkdown = memo(function HighlightedMessageMarkdown({
  content,
  query,
  onOpenFile,
  resolveFilePath,
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
      <MessageMarkdown
        content={content}
        onOpenFile={onOpenFile}
        resolveFilePath={resolveFilePath}
      />
    </div>
  );
});

// Block-level tags that bound a "match container". Text nodes inside the
// same block-tag ancestor get joined when searching, so a query can span
// inline elements (e.g., across Shiki token spans inside <pre>, or across
// <em>/<strong> inside a <p>) — but never across paragraph or list-item
// boundaries, which would produce confusing matches with no visible
// separator. Tag-name lookup is cheaper than getComputedStyle().
const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE", "BLOCKQUOTE",
  "TD", "TH", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "DD", "DT",
]);

function nearestBlockAncestor(el: Element | null, root: HTMLElement): Element {
  let cur: Element | null = el;
  while (cur && cur !== root) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return root;
}

function applyHighlights(root: HTMLElement, query: string): void {
  if (!query) return;

  // Group all text nodes by their nearest block ancestor. Cross-token /
  // cross-inline-element matches inside the same block then "just work"
  // because we match against the block's joined text rather than each
  // text node in isolation. This is what makes a search like "def " land
  // when Shiki has tokenized "def" and " " into adjacent <span>s.
  const groups = new Map<Element, Text[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text already wrapped in a previous mark (defensive — cleanup
      // should have removed them, but the check makes re-runs idempotent).
      let p: Node | null = node.parentNode;
      while (p && p !== root) {
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

  let n: Node | null;
  while ((n = walker.nextNode())) {
    const container = nearestBlockAncestor(n.parentNode as Element, root);
    let arr = groups.get(container);
    if (!arr) {
      arr = [];
      groups.set(container, arr);
    }
    arr.push(n as Text);
  }

  for (const nodes of groups.values()) {
    highlightTextNodeGroup(nodes, query);
  }
}

function highlightTextNodeGroup(nodes: Text[], query: string): void {
  if (nodes.length === 0) return;
  // Build a single joined string spanning every text node in this block,
  // then run the shared regex finder against it. Matches are returned in
  // joined-string coordinates; we then walk back through the nodes and
  // apply each match's portion to whichever node(s) it lands on.
  const joined = nodes.map((t) => t.nodeValue ?? "").join("");
  const ranges = findAllRanges(joined, query);
  if (ranges.length === 0) return;

  // Assign a stable id per logical range up-front so every <mark> we
  // produce for that range can be tagged with the same `data-match-id`.
  // ChatSearchBar uses these ids to collapse split matches into a single
  // counter entry and to apply the active class to all of a match's
  // pieces simultaneously.
  const rangeIds = ranges.map(() => nextSearchMatchId());

  let nodeStart = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const nodeEnd = nodeStart + text.length;

    // Collect all match sub-ranges that fall inside this node, expressed
    // as local (text-relative) offsets, paired with their range id.
    const subRanges: Array<{ start: number; end: number; id: string }> = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.end <= nodeStart || r.start >= nodeEnd) continue;
      subRanges.push({
        start: Math.max(0, r.start - nodeStart),
        end: Math.min(text.length, r.end - nodeStart),
        id: rangeIds[i],
      });
    }

    if (subRanges.length > 0) {
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const sr of subRanges) {
        if (sr.start > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, sr.start)));
        }
        const mark = document.createElement("mark");
        mark.className = SEARCH_MARK_CLASS;
        mark.dataset.matchId = sr.id;
        mark.textContent = text.slice(sr.start, sr.end);
        fragment.appendChild(mark);
        cursor = sr.end;
      }
      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }
      node.parentNode?.replaceChild(fragment, node);
    }

    nodeStart = nodeEnd;
  }
}

function removeHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${SEARCH_MARK_CLASS}`);
  if (marks.length === 0) return;
  // Collect every parent we touched so we can normalize each one only once
  // at the end. Calling Node.normalize() per-mark inside the loop is O(N²)
  // when many matches share the same parent — each call walks all of that
  // parent's children to merge adjacent text nodes.
  const parentsToNormalize = new Set<Node>();
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(
      document.createTextNode(mark.textContent ?? ""),
      mark,
    );
    parentsToNormalize.add(parent);
  }
  for (const parent of parentsToNormalize) {
    parent.normalize();
  }
}
