import { describe, it, expect } from "vitest";
import { EXTERNAL_SCHEMES } from "./markdown";

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
