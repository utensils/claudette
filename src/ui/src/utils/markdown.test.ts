// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Components } from "react-markdown";

const tauriMocks = vi.hoisted(() => ({
  openUrl: vi.fn(() => Promise.resolve()),
  openInEditor: vi.fn(() => Promise.resolve()),
}));

vi.mock("../services/tauri", () => ({
  openUrl: tauriMocks.openUrl,
  openInEditor: tauriMocks.openInEditor,
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
        createElement(HighlightedCode, { children: "foo.ts" }),
      ),
    );

    expect(container.querySelector("code")?.textContent).toBe("foo.ts");
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
  const LinkOverride = MARKDOWN_COMPONENTS.a as NonNullable<Components["a"]>;

  beforeEach(() => {
    tauriMocks.openUrl.mockClear();
    tauriMocks.openInEditor.mockClear();
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
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("does not double-render file buttons for linked inline code", async () => {
    const openFile = vi.fn(() => true);
    const resolveFilePath = vi.fn((path: string) =>
      path === "Cargo.toml" ? "Cargo.toml" : null,
    );
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath } },
        createElement(LinkOverride, {
          href: "claudettepath:Cargo.toml",
          children: createElement(HighlightedCode, { children: "Cargo.toml" }),
        }),
      ),
    );

    const buttons = container.querySelectorAll("button.cc-file-path-link");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.querySelector("button")).toBeNull();
    expect(buttons[0]?.querySelector("code")?.textContent).toBe("Cargo.toml");
    buttons[0]?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("Cargo.toml");
    expect(tauriMocks.openInEditor).not.toHaveBeenCalled();
  });

  it("routes at-sign file mentions only when the workspace index resolves them", async () => {
    const openFile = vi.fn(() => true);
    const resolveFilePath = vi.fn((path: string) =>
      path === "README.md" ? "docs/README.md" : null,
    );
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath } },
        createElement(LinkOverride, {
          href: "claudettepath:README.md",
          children: "@README.md",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("@README.md");
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(resolveFilePath).toHaveBeenCalledWith("README.md");
    expect(openFile).toHaveBeenCalledWith("docs/README.md");
  });

  it("routes bare file links only when the workspace index resolves them", async () => {
    const openFile = vi.fn(() => true);
    const resolveFilePath = vi.fn((path: string) =>
      path === "README.md" ? "docs/README.md" : null,
    );
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath } },
        createElement(LinkOverride, {
          href: "claudettepath:README.md",
          children: "README.md",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("README.md");
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(resolveFilePath).toHaveBeenCalledWith("README.md");
    expect(openFile).toHaveBeenCalledWith("docs/README.md");
  });

  it("leaves unresolved at-sign mentions as plain text", async () => {
    const openFile = vi.fn(() => true);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath: () => null } },
        createElement(LinkOverride, {
          href: "claudettepath:README.md",
          children: "@README.md",
        }),
      ),
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("@README.md");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("leaves unresolved bare file links as plain text when a resolver is available", async () => {
    const openFile = vi.fn(() => true);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath: () => null } },
        createElement(LinkOverride, {
          href: "claudettepath:README.md",
          children: "README.md",
        }),
      ),
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("README.md");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("routes explicit relative file paths through Monaco even before the workspace index resolves them", async () => {
    const openFile = vi.fn(() => true);
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath: () => null } },
        createElement(LinkOverride, {
          href: "claudettepath:./tmp/report.csv",
          children: createElement(HighlightedCode, { children: "./tmp/report.csv" }),
        }),
      ),
    );

    const button = container.querySelector("button.cc-file-path-link");
    expect(button).toBeTruthy();
    expect(button?.querySelector("code")?.textContent).toBe("./tmp/report.csv");
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("./tmp/report.csv");
    expect(tauriMocks.openInEditor).not.toHaveBeenCalled();
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens explicit absolute file paths in the native app when Monaco cannot handle them", async () => {
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

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("/tmp/report.md");
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(tauriMocks.openInEditor).toHaveBeenCalledWith("/tmp/report.md");
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens explicit absolute file paths in the native app when the Monaco opener throws", async () => {
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
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("does not open localhost file URLs in the browser when Monaco cannot handle them", async () => {
    const openFile = vi.fn(() => false);
    const href =
      "http://localhost:14255/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/website/guide/quickstart.md:6";
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href,
          children: href,
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.textContent).toBe("website/guide/quickstart.md:6");
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith(
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/website/guide/quickstart.md:6",
    );
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
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
    expect(button?.textContent).toBe("CLAUDETTE_TEST.md:1");
    expect(container.querySelector("a")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith("/Users/me/project/CLAUDETTE_TEST.md:1");
  });

  it("routes localhost file URLs through the workspace-resolved display path when available", async () => {
    const openFile = vi.fn(() => true);
    const resolveFilePath = vi.fn((path: string) =>
      path === "website/guide/quickstart.md:6"
        ? "website/guide/quickstart.md:6"
        : null,
    );
    const href =
      "http://localhost:14255/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/website/guide/quickstart.md:6";
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile, resolveFilePath } },
        createElement(LinkOverride, {
          href,
          children: href,
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.textContent).toBe("website/guide/quickstart.md:6");
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(resolveFilePath).toHaveBeenCalledWith(
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/website/guide/quickstart.md:6",
    );
    expect(resolveFilePath).toHaveBeenCalledWith("website/guide/quickstart.md:6");
    expect(openFile).toHaveBeenCalledWith("website/guide/quickstart.md:6");
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("routes localhost SVG file URLs through the Monaco file opener", async () => {
    const openFile = vi.fn(() => true);
    const href =
      "http://localhost:14254/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/simple-wave.svg:1";
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href,
          children: href,
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.textContent).toBe("simple-wave.svg:1");
    expect(container.querySelector("a")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith(
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/simple-wave.svg:1",
    );
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("routes same-origin absolute file hrefs through Monaco instead of rendering an app-route anchor", async () => {
    const openFile = vi.fn(() => true);
    const href =
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/README.md:8";
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href,
          children: "README.md",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.textContent).toBe("README.md:8");
    expect(container.querySelector("a")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith(href);
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("routes same-origin absolute file hrefs with unknown extensions through Monaco", async () => {
    const openFile = vi.fn(() => true);
    const href =
      "/Users/jamesbrink/.claudette/workspaces/claudex/copper-ginger/generated.assetbundle:12";
    const container = await render(
      createElement(
        MarkdownFileOpenContext.Provider,
        { value: { openFile } },
        createElement(LinkOverride, {
          href,
          children: "generated.assetbundle",
        }),
      ),
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    expect(button?.textContent).toBe("generated.assetbundle:12");
    expect(container.querySelector("a")).toBeNull();
    button?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    expect(openFile).toHaveBeenCalledWith(href);
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("blocks unsupported anchors from navigating the webview", async () => {
    const container = await render(
      createElement(LinkOverride, {
        href: "/internal/app/path",
        children: "internal",
      }),
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });

    container.querySelector("a")?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(tauriMocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens scheme-less www links through open_url with an https URL", async () => {
    const container = await render(
      createElement(LinkOverride, {
        href: "www.example.com/docs",
        children: "www.example.com/docs",
      }),
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.example.com/docs");
    link?.dispatchEvent(
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
