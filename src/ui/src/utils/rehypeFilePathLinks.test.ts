import { describe, it, expect } from "vitest";
import type { Element, Root, Text } from "hast";

import { rehypeFilePathLinks } from "./rehypeFilePathLinks";

/** Build a paragraph node with the given children — the typical thing
 *  remark→rehype emits for a plain text run. */
function paragraph(...children: Array<Element | Text>): Element {
  return { type: "element", tagName: "p", properties: {}, children };
}

function text(value: string): Text {
  return { type: "text", value };
}

function root(...children: Array<Element | Text>): Root {
  return { type: "root", children };
}

/** Run the plugin against an in-memory hast tree and return it. The
 *  plugin mutates in place; we return the same tree for ergonomics. */
function run(tree: Root): Root {
  // The plugin function returned from the factory takes (tree) and
  // mutates it. Cast through unknown to drop unified's generic
  // `this`-typed Processor signature — we're calling it directly,
  // not registering with unified.
  const transformer = rehypeFilePathLinks.call(undefined as never) as unknown as (
    t: Root,
  ) => void;
  transformer(tree);
  return tree;
}

describe("rehypeFilePathLinks", () => {
  it("wraps an absolute path inside a paragraph", () => {
    const tree = root(paragraph(text("open /tmp/foo.csv now")));
    run(tree);

    const p = tree.children[0] as Element;
    expect(p.children).toHaveLength(3);
    expect(p.children[0]).toEqual({ type: "text", value: "open " });
    const link = p.children[1] as Element;
    expect(link.tagName).toBe("a");
    expect(link.properties?.href).toBe("claudettepath:/tmp/foo.csv");
    expect(link.properties?.className).toEqual(["cc-file-path-link"]);
    expect(link.children).toEqual([{ type: "text", value: "/tmp/foo.csv" }]);
    expect(p.children[2]).toEqual({ type: "text", value: " now" });
  });

  it("wraps a bare workspace file reference inside a paragraph", () => {
    const tree = root(paragraph(text("Edit README.md next")));
    run(tree);

    const p = tree.children[0] as Element;
    expect(p.children[0]).toEqual({ type: "text", value: "Edit " });
    const link = p.children[1] as Element;
    expect(link.tagName).toBe("a");
    expect(link.properties?.href).toBe("claudettepath:README.md");
    expect(link.children).toEqual([{ type: "text", value: "README.md" }]);
    expect(p.children[2]).toEqual({ type: "text", value: " next" });
  });

  it("converts GFM domain-autolinked file names back into file links", () => {
    const autolink: Element = {
      type: "element",
      tagName: "a",
      properties: { href: "http://README.md" },
      children: [text("README.md")],
    };
    const tree = root(paragraph(text("Edit "), autolink));
    run(tree);

    const p = tree.children[0] as Element;
    const link = p.children[1] as Element;
    expect(link.properties?.href).toBe("claudettepath:README.md");
    expect(link.properties?.className).toEqual(["cc-file-path-link"]);
  });

  it("keeps real GFM autolinked URLs as URLs", () => {
    const autolink: Element = {
      type: "element",
      tagName: "a",
      properties: { href: "http://example.com" },
      children: [text("example.com")],
    };
    const tree = root(paragraph(autolink));
    run(tree);

    const p = tree.children[0] as Element;
    const link = p.children[0] as Element;
    expect(link.properties?.href).toBe("http://example.com");
    expect(link.properties?.className).toBeUndefined();
  });

  it("leaves paths inside <code> alone", () => {
    const code: Element = {
      type: "element",
      tagName: "code",
      properties: {},
      children: [text("/tmp/foo.csv")],
    };
    const tree = root(paragraph(code));
    run(tree);

    const p = tree.children[0] as Element;
    const stillCode = p.children[0] as Element;
    expect(stillCode.tagName).toBe("code");
    expect(stillCode.children).toEqual([{ type: "text", value: "/tmp/foo.csv" }]);
  });

  it("leaves paths inside <pre> alone", () => {
    const pre: Element = {
      type: "element",
      tagName: "pre",
      properties: {},
      children: [text("/tmp/foo.csv")],
    };
    const tree = root(pre);
    run(tree);

    const stillPre = tree.children[0] as Element;
    expect(stillPre.tagName).toBe("pre");
    expect(stillPre.children).toEqual([{ type: "text", value: "/tmp/foo.csv" }]);
  });

  it("leaves paths inside an existing <a> alone", () => {
    const link: Element = {
      type: "element",
      tagName: "a",
      properties: { href: "https://example.com" },
      children: [text("/tmp/foo.csv")],
    };
    const tree = root(paragraph(link));
    run(tree);

    const p = tree.children[0] as Element;
    const stillLink = p.children[0] as Element;
    expect(stillLink.properties?.href).toBe("https://example.com");
    expect(stillLink.children).toEqual([{ type: "text", value: "/tmp/foo.csv" }]);
  });

  it("handles multiple paths in one text node", () => {
    const tree = root(paragraph(text("from /tmp/in.csv to /tmp/out.csv done")));
    run(tree);

    const p = tree.children[0] as Element;
    const links = p.children.filter(
      (c): c is Element => c.type === "element" && c.tagName === "a",
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.properties?.href).toBe("claudettepath:/tmp/in.csv");
    expect(links[1]?.properties?.href).toBe("claudettepath:/tmp/out.csv");
  });

  it("does not absorb a trailing sentence period into the link", () => {
    const tree = root(paragraph(text("Saved to /tmp/foo.csv.")));
    run(tree);

    const p = tree.children[0] as Element;
    const link = p.children.find(
      (c): c is Element => c.type === "element" && c.tagName === "a",
    );
    expect(link?.children).toEqual([
      { type: "text", value: "/tmp/foo.csv" },
    ]);
    // The period survives as a separate trailing text node.
    expect(p.children[p.children.length - 1]).toEqual({
      type: "text",
      value: ".",
    });
  });
});
