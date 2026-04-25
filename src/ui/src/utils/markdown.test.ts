import { describe, it, expect } from "vitest";
import { createElement } from "react";
import type { ReactElement } from "react";
import { EXTERNAL_SCHEMES, trimTrailingCodeNewline, MARKDOWN_COMPONENTS } from "./markdown";

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

describe("trimTrailingCodeNewline", () => {
  it("strips a trailing newline from a single string child", () => {
    expect(trimTrailingCodeNewline("const x = 1;\n")).toEqual(["const x = 1;"]);
  });

  it("strips multiple trailing newlines", () => {
    expect(trimTrailingCodeNewline("const x = 1;\n\n\n")).toEqual(["const x = 1;"]);
  });

  it("preserves internal newlines", () => {
    expect(trimTrailingCodeNewline("a\nb\nc\n")).toEqual(["a\nb\nc"]);
  });

  it("drops a trailing whitespace-only text node", () => {
    const span = createElement("span", { key: "k" }, "code");
    const result = trimTrailingCodeNewline([span, "\n"]) as React.ReactNode[];
    expect(result).toHaveLength(1);
    expect((result[0] as React.ReactElement).type).toBe("span");
  });

  it("trims trailing newline from the last text node after a span", () => {
    const span = createElement("span", { key: "k" }, "const");
    const result = trimTrailingCodeNewline([span, " x = 1;\n"]) as React.ReactNode[];
    expect(result).toHaveLength(2);
    expect((result[0] as React.ReactElement).type).toBe("span");
    expect(result[1]).toBe(" x = 1;");
  });

  it("returns the original children reference when there is no trailing newline", () => {
    const span = createElement("span", { key: "k" }, "const");
    const input: React.ReactNode = [span, " x = 1;"];
    expect(trimTrailingCodeNewline(input)).toBe(input);
  });

  it("returns the original string unchanged when no trailing newline", () => {
    expect(trimTrailingCodeNewline("code")).toBe("code");
  });

  it("returns the original input when children are empty", () => {
    expect(trimTrailingCodeNewline([])).toEqual([]);
    expect(trimTrailingCodeNewline(null)).toBe(null);
  });

  it("returns children unchanged when last child is a non-string element", () => {
    const span = createElement("span", { key: "k" }, "code");
    const input: React.ReactNode = [span];
    expect(trimTrailingCodeNewline(input)).toBe(input);
  });
});

describe("MARKDOWN_COMPONENTS.code", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CodeComponent = MARKDOWN_COMPONENTS.code as (props: any) => ReactElement;

  function renderCode(props: Record<string, unknown>): ReactElement {
    return CodeComponent({ node: undefined, ...props });
  }
  function propsOf(el: ReactElement): Record<string, unknown> {
    return (el as unknown as { props: Record<string, unknown> }).props;
  }

  it("strips trailing newline from fenced code blocks (hljs class)", () => {
    const span = createElement("span", { className: "hljs-keyword", key: "k" }, "const");
    const el = renderCode({ className: "hljs language-js", children: [span, " x = 1;\n"] });
    expect(el.type).toBe("code");
    expect(propsOf(el).className).toBe("hljs language-js");
    const kids = propsOf(el).children as React.ReactNode[];
    expect(kids).toHaveLength(2);
    expect(kids[1]).toBe(" x = 1;");
  });

  it("strips trailing newline from fenced code blocks (language- class)", () => {
    const el = renderCode({ className: "language-python", children: "print('hello')\n" });
    expect(el.type).toBe("code");
    const kids = propsOf(el).children as React.ReactNode[];
    expect(kids).toHaveLength(1);
    expect(kids[0]).toBe("print('hello')");
  });

  it("does NOT strip newlines from inline code (no language class)", () => {
    const el = renderCode({ children: "some code" });
    expect(propsOf(el).children).toBe("some code");
  });

  it("does NOT strip newlines when className is undefined", () => {
    const el = renderCode({ className: undefined, children: "inline\n" });
    expect(propsOf(el).children).toBe("inline\n");
  });

  it("preserves className on the rendered code element", () => {
    const el = renderCode({ className: "hljs language-rust", children: "fn main() {}\n" });
    expect(propsOf(el).className).toBe("hljs language-rust");
  });
});
