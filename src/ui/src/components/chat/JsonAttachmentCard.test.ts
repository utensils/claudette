import { describe, it, expect } from "vitest";

import { prettyPrintJson } from "./JsonAttachmentCard";

describe("prettyPrintJson", () => {
  it("indents valid JSON with 2 spaces", () => {
    const { formatted, parsed } = prettyPrintJson('{"a":1,"b":[2,3]}');
    expect(parsed).toBe(true);
    expect(formatted).toBe(`{
  "a": 1,
  "b": [
    2,
    3
  ]
}`);
  });

  it("falls back to raw input when JSON is invalid", () => {
    const raw = '{"a": 1,';
    const { formatted, parsed } = prettyPrintJson(raw);
    expect(parsed).toBe(false);
    expect(formatted).toBe(raw);
  });
});
