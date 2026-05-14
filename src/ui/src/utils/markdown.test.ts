import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./highlight", () => ({
  getCachedHighlight: vi.fn(),
  highlightCode: vi.fn(),
}));

import {
  EXTERNAL_SCHEMES,
  MARKDOWN_COMPONENTS,
  SANITIZE_SCHEMA,
  HighlightedCode,
  safeUrlTransform,
} from "./markdown";
import { getCachedHighlight, highlightCode } from "./highlight";

describe("EXTERNAL_SCHEMES", () => {
  it("matches http URLs", () => {
    expect(EXTERNAL_SCHEMES.test("http://example.com")).toBe(true);
  });

  it("matches https URLs", () => {
    expect(EXTERNAL_SCHEMES.test("https://github.com/utensils/claudette")).toBe(true);
  });

  it("matches mailto URLs", () => {
    expect(EXTERNAL_SCHEMES.test("mailto:user@example.com")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(EXTERNAL_SCHEMES.test("HTTPS://EXAMPLE.COM")).toBe(true);
    expect(EXTERNAL_SCHEMES.test("HTTP://EXAMPLE.COM")).toBe(true);
    expect(EXTERNAL_SCHEMES.test("Mailto:user@example.com")).toBe(true);
  });

  it("rejects file:// URLs", () => {
    expect(EXTERNAL_SCHEMES.test("file:///etc/passwd")).toBe(false);
  });

  it("rejects javascript: URLs", () => {
    expect(EXTERNAL_SCHEMES.test("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(EXTERNAL_SCHEMES.test("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  it("rejects fragment links", () => {
    expect(EXTERNAL_SCHEMES.test("#section")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(EXTERNAL_SCHEMES.test("/some/path")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(EXTERNAL_SCHEMES.test("")).toBe(false);
  });
});

describe("MARKDOWN_COMPONENTS.code wiring", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CodeOverride = MARKDOWN_COMPONENTS.code as (props: any) => ReactElement;

  it("returns a HighlightedCode element forwarding className and children", () => {
    const el = CodeOverride({
      node: undefined,
      className: "language-rust",
      children: "fn main() {}",
    });
    expect(el.type).toBe(HighlightedCode);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (el as unknown as { props: any }).props;
    expect(props.className).toBe("language-rust");
    expect(props.children).toBe("fn main() {}");
  });

  it("strips the `node` prop before forwarding", () => {
    const el = CodeOverride({
      node: { fake: true },
      className: "language-ts",
      children: "const x = 1",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (el as unknown as { props: any }).props;
    expect(props.node).toBeUndefined();
  });
});

describe("safeUrlTransform", () => {
  it("allows SVG data URLs only for image src/srcSet attributes", () => {
    const svg = "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E";

    expect(safeUrlTransform(svg, "src", { tagName: "img" })).toBe(svg);
    expect(safeUrlTransform(svg, "srcSet", { tagName: "source" })).toBe(svg);
    expect(safeUrlTransform(svg, "href", { tagName: "a" })).toBe("");
    expect(safeUrlTransform(svg)).toBe("");
  });

  it("rejects non-image data URLs for image src attributes", () => {
    expect(
      safeUrlTransform("data:text/html,<script>alert(1)</script>", "src", {
        tagName: "img",
      }),
    ).toBe("");
  });

  it("keeps data protocol sanitization scoped to image src", () => {
    expect(SANITIZE_SCHEMA.protocols.src).toContain("data");
    expect(SANITIZE_SCHEMA.protocols.srcSet).toContain("data");
    expect(SANITIZE_SCHEMA.protocols.href).not.toContain("data");
  });

  it("preserves GitHub-style picture attributes", () => {
    expect(SANITIZE_SCHEMA.attributes.img).toEqual(
      expect.arrayContaining(["src", "alt", "width", "height"]),
    );
    expect(SANITIZE_SCHEMA.attributes.source).toEqual(
      expect.arrayContaining(["srcSet", "media"]),
    );
  });
});

describe("HighlightedCode", () => {
  beforeEach(() => {
    vi.mocked(getCachedHighlight).mockReset();
    vi.mocked(highlightCode).mockReset();
    vi.mocked(getCachedHighlight).mockReturnValue(null);
    vi.mocked(highlightCode).mockResolvedValue(null);
  });

  it("renders inline <code> when there is no language class", () => {
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, { children: "x" }),
    );
    expect(html).toBe("<code>x</code>");
    expect(getCachedHighlight).not.toHaveBeenCalled();
  });

  it("renders plain <code> when language is set but no cached highlight", () => {
    vi.mocked(getCachedHighlight).mockReturnValue(null);
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, {
        className: "language-rust",
        children: "fn main() {}",
      }),
    );
    expect(html).toBe('<code class="language-rust">fn main() {}</code>');
    expect(getCachedHighlight).toHaveBeenCalledWith("fn main() {}", "rust");
  });

  it("renders dangerouslySetInnerHTML when cache returns highlighted HTML", () => {
    vi.mocked(getCachedHighlight).mockReturnValue('<span style="color:var(--syntax-keyword)">fn</span>');
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, {
        className: "language-rust",
        children: "fn",
      }),
    );
    expect(html).toBe('<code class="language-rust"><span style="color:var(--syntax-keyword)">fn</span></code>');
  });

  it("preserves className on the rendered code element", () => {
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, {
        className: "language-typescript",
        children: "const x = 1",
      }),
    );
    expect(html).toContain('class="language-typescript"');
  });

  it("treats className without language- prefix as inline code", () => {
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, { className: "math", children: "1+1" }),
    );
    expect(html).toBe('<code class="math">1+1</code>');
    expect(getCachedHighlight).not.toHaveBeenCalled();
  });

  it("extracts language with hyphen (language-shell-script)", () => {
    vi.mocked(getCachedHighlight).mockReturnValue(null);
    renderToStaticMarkup(
      createElement(HighlightedCode, {
        className: "language-shell-script",
        children: "echo hi",
      }),
    );
    expect(getCachedHighlight).toHaveBeenCalledWith("echo hi", "shell-script");
  });
});
