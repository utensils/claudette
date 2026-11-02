import { describe, expect, it } from "vitest";
import { nonEmptyStringField, parseToolInput } from "./toolInput";

describe("parseToolInput", () => {
  it("returns plain objects", () => {
    expect(parseToolInput('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null for empty, malformed, array, and scalar input", () => {
    expect(parseToolInput("")).toBeNull();
    expect(parseToolInput(undefined)).toBeNull();
    expect(parseToolInput('{"a":')).toBeNull();
    expect(parseToolInput("[1,2]")).toBeNull();
    expect(parseToolInput("null")).toBeNull();
    expect(parseToolInput("42")).toBeNull();
  });

  it("returns the same object for repeated input", () => {
    const json = '{"file_path":"/tmp/x"}';
    expect(parseToolInput(json)).toBe(parseToolInput(json));
  });
});

describe("nonEmptyStringField", () => {
  it("trims strings and rejects blanks and non-strings", () => {
    expect(nonEmptyStringField("  hi ")).toBe("hi");
    expect(nonEmptyStringField("   ")).toBeUndefined();
    expect(nonEmptyStringField(3)).toBeUndefined();
  });
});
