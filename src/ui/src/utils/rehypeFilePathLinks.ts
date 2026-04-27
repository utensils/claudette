/**
 * Rehype plugin that scans text nodes for absolute file paths and rewrites
 * each match as an `<a href="claudettepath:…">` element. The MARKDOWN_COMPONENTS.a
 * override in `markdown.ts` recognises that scheme and routes clicks into a
 * Tauri command so the user's default app opens the file.
 *
 * Skipped contexts: anywhere already inside `<code>`, `<pre>`, or `<a>`. We
 * don't want to mangle code samples (where slashes are syntactic) or stack
 * up nested anchors when the path was already a real link.
 */
import type { Plugin } from "unified";
import type { Element, ElementContent, Root, Text } from "hast";
import { visitParents } from "unist-util-visit-parents";

import { detectFilePaths, encodeFilePathHref } from "./filePathLinks";

const SKIP_TAGS = new Set(["code", "pre", "a"]);

export const rehypeFilePathLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visitParents(tree, "text", (node: Text, ancestors) => {
      // unist-util-visit-parents passes the ancestor chain root-first.
      // Any element ancestor that's a code/pre/a means we're inside one
      // of those subtrees and should leave the text alone.
      for (const a of ancestors) {
        if (a.type === "element" && SKIP_TAGS.has((a as Element).tagName)) {
          return;
        }
      }

      const matches = detectFilePaths(node.value);
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
          children: [{ type: "text", value: m.path }],
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
