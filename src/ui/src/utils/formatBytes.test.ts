import { describe, it, expect } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes (binary units)", () => {
  it("returns bytes below 1 KiB without decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to KiB at 1024", () => {
    expect(formatBytes(1024)).toMatch(/^1(\.0)? KiB$/);
    expect(formatBytes(1536)).toMatch(/^1\.5 KiB$/);
  });

  it("switches to MiB at 1 MiB", () => {
    expect(formatBytes(1024 * 1024)).toMatch(/^1(\.0)? MiB$/);
  });

  it("switches to GiB at 1 GiB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toMatch(/^1(\.0)? GiB$/);
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toMatch(/^2\.5 GiB$/);
  });

  it("handles bogus inputs without throwing", () => {
    expect(() => formatBytes(null)).not.toThrow();
    expect(() => formatBytes(undefined)).not.toThrow();
    expect(() => formatBytes(NaN)).not.toThrow();
    expect(() => formatBytes(-1)).not.toThrow();
  });
});
