/**
 * Rehype plugin that scans text nodes for file paths and rewrites
 * each match as an `<a href="claudettepath:…">` element. The MARKDOWN_COMPONENTS.a
 * override in `markdown.ts` recognises that scheme and routes clicks into a
 * workspace file opener when one is available.
 *
 * Skipped contexts: anywhere already inside `<code>`, `<pre>`, or `<a>`. We
 * don't want to mangle code samples (where slashes are syntactic) or stack
 * up nested anchors when the path was already a real link.
 */
import type { Plugin } from "unified";
import type { Element, ElementContent, Root, Text } from "hast";
import { visitParents } from "unist-util-visit-parents";

import {
  detectFileReferences,
  encodeFilePathHref,
  isLikelyRelativeFileReference,
} from "./filePathLinks";

const SKIP_TAGS = new Set(["code", "pre", "a"]);

export const rehypeFilePathLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visitParents(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href =
        typeof node.properties?.href === "string" ? node.properties.href : "";
      const text = singleTextChild(node);
      if (!href || !text || !isLikelyRelativeFileReference(text)) return;
      if (!isAutolinkedFileReference(href, text)) return;

      node.properties = {
        ...node.properties,
        href: encodeFilePathHref(text),
        className: mergeClassName(node.properties.className, "cc-file-path-link"),
      };
    });

    visitParents(tree, "text", (node: Text, ancestors) => {
      // unist-util-visit-parents passes the ancestor chain root-first.
      // Any element ancestor that's a code/pre/a means we're inside one
      // of those subtrees and should leave the text alone.
      for (const a of ancestors) {
        if (a.type === "element" && SKIP_TAGS.has((a as Element).tagName)) {
          return;
        }
      }

      const matches = detectFileReferences(node.value);
      if (matches.length === 0) return;

      const replacement: ElementContent[] = [];
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) {
          replacement.push({
            type: "text",
            value: node.value.slice(cursor, m.start),
          });
        }
        replacement.push({
          type: "element",
          tagName: "a",
          properties: {
            href: encodeFilePathHref(m.path),
            className: ["cc-file-path-link"],
          },
          children: [{ type: "text", value: m.text ?? m.path }],
        });
        cursor = m.end;
      }
      if (cursor < node.value.length) {
        replacement.push({
          type: "text",
          value: node.value.slice(cursor),
        });
      }

      const parent = ancestors[ancestors.length - 1];
      if (!parent || !("children" in parent)) return;
      const idx = parent.children.indexOf(node);
      if (idx < 0) return;
      parent.children.splice(idx, 1, ...replacement);
    });
  };
};

function singleTextChild(node: Element): string | null {
  if (node.children.length !== 1) return null;
  const child = node.children[0];
  return child.type === "text" ? child.value.trim() : null;
}

function isAutolinkedFileReference(href: string, text: string): boolean {
  const normalizedText = text.trim();
  const normalizedHref = href.trim();
  if (normalizedHref === normalizedText) return true;
  return /^https?:\/\//i.test(normalizedHref)
    && normalizedHref.replace(/^https?:\/\//i, "") === normalizedText;
}

function mergeClassName(
  value: unknown,
  className: string,
): string[] {
  const current = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : [];
  return current.includes(className) ? current : [...current, className];
}
