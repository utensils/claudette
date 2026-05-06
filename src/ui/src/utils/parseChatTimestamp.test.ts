import { describe, expect, it } from "vitest";
import { parseChatTimestamp } from "./parseChatTimestamp";

describe("parseChatTimestamp", () => {
  it("parses SQLite datetime strings as UTC", () => {
    expect(parseChatTimestamp("2026-05-06 02:59:14")).toBe(
      Date.parse("2026-05-06T02:59:14Z"),
    );
  });

  it("continues to parse ISO timestamps", () => {
    expect(parseChatTimestamp("2026-05-06T02:59:14Z")).toBe(
      Date.parse("2026-05-06T02:59:14Z"),
    );
  });

  it("returns NaN for missing timestamps", () => {
    expect(Number.isNaN(parseChatTimestamp(null))).toBe(true);
  });
});
