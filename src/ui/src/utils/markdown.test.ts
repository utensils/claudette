// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  openInEditor: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("../services/tauri", () => ({
  openInEditor: tauriMocks.openInEditor,
  openUrl: tauriMocks.openUrl,
}));

vi.mock("./highlight", () => ({
  getCachedHighlight: vi.fn(),
  highlightCode: vi.fn(),
}));

import {
  EXTERNAL_SCHEMES,
  MARKDOWN_COMPONENTS,
  MarkdownFileOpenContext,
  normalizeExternalHref,
  SANITIZE_SCHEMA,
  HighlightedCode,
  safeUrlTransform,
} from "./markdown";
import { getCachedHighlight, highlightCode } from "./highlight";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

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

  it("turns inline code into a file button when the context resolves it", async () => {
    const openFile = vi.fn(() => true);
    const resolveFilePath = vi.fn((path: string) =>
      path === "Cargo.toml" ? "Cargo.toml" : null,
    );
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath } },
        createElement(HighlightedCode, { children: "Cargo.toml" }),
      ),
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Cargo.toml");
    expect(container.querySelector("code")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(resolveFilePath).toHaveBeenCalledWith("Cargo.toml");
    expect(openFile).toHaveBeenCalledWith("Cargo.toml");
  });

  it("leaves inline code alone when the context cannot resolve it", async () => {
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile: vi.fn(), resolveFilePath: () => null } },
        createElement(HighlightedCode, { children: "not-a-file" }),
      ),
    );

    expect(container.querySelector("code")?.textContent).toBe("not-a-file");
    expect(container.querySelector("button")).toBeNull();
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

describe("normalizeExternalHref", () => {
  it("keeps explicit http, https, and mailto links", () => {
    expect(normalizeExternalHref("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(normalizeExternalHref("http://example.com")).toBe("http://example.com");
    expect(normalizeExternalHref("mailto:user@example.com")).toBe(
      "mailto:user@example.com",
    );
  });

  it("upgrades www links that GFM can emit without a scheme", () => {
    expect(normalizeExternalHref("www.example.com/docs")).toBe(
      "https://www.example.com/docs",
    );
  });

  it("rejects relative files and unsafe schemes", () => {
    expect(normalizeExternalHref("README.md")).toBeNull();
    expect(normalizeExternalHref("javascript:alert(1)")).toBeNull();
  });
});

describe("MARKDOWN_COMPONENTS.a click handling", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LinkOverride = MARKDOWN_COMPONENTS.a as (props: any) => ReactElement;

  beforeEach(() => {
    tauriMocks.invoke.mockClear();
    tauriMocks.openInEditor.mockClear();
    tauriMocks.openUrl.mockClear();
  });

  it("routes claudettepath links through the Monaco file opener context", async () => {
    const openFile = vi.fn(() => true);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href: "claudettepath:README.md",
          children: "README.md",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("href")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("README.md");
    expect(tauriMocks.openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the native opener for absolute file paths outside Monaco", async () => {
    const openFile = vi.fn(() => false);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href: "claudettepath:/tmp/report.md",
          children: "/tmp/report.md",
        }),
      ),
    );

    container.querySelector("button")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("/tmp/report.md");
    expect(tauriMocks.openInEditor).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("falls back to the native opener when the Monaco opener throws", async () => {
    const openFile = vi.fn(() => {
      throw new Error("boom");
    });
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href: "claudettepath:/tmp/report.md",
          children: "/tmp/report.md",
        }),
      ),
    );

    container.querySelector("button")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("/tmp/report.md");
    expect(tauriMocks.openInEditor).toHaveBeenCalledWith("/tmp/report.md");
  });

  it("routes localhost file URLs through the Monaco file opener without rendering a navigable href", async () => {
    const openFile = vi.fn(() => true);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href: "http://localhost:14254/Users/me/project/CLAUDETTE_TEST.md:1",
          children: "http://localhost:14254/Users/me/project/CLAUDETTE_TEST.md:1",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("/Users/me/project/CLAUDETTE_TEST.md:1");
  });

  it("opens scheme-less www links through open_url with an https URL", async () => {
    const container = await render(
      createElement(LinkOverride, {
        href: "www.example.com/docs",
        children: "www.example.com/docs",
      }),
    );

    container.querySelector("a")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(tauriMocks.openUrl).toHaveBeenCalledWith("https://www.example.com/docs");
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
    vi.mocked(getCachedHighlight).mockReturnValue('<span style="--shiki-light:black">fn</span>');
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, {
        className: "language-rust",
        children: "fn",
      }),
    );
    expect(html).toBe('<code class="language-rust"><span style="--shiki-light:black">fn</span></code>');
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
