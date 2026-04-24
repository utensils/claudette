import { describe, expect, it } from "vitest";
import { shouldForwardPtyResize } from "./terminalPtyResize";

describe("shouldForwardPtyResize", () => {
  it("forwards the first concrete size", () => {
    expect(
      shouldForwardPtyResize(null, { cols: 120, rows: 34 }),
    ).toBe(true);
  });

  it("suppresses identical consecutive sizes", () => {
    expect(
      shouldForwardPtyResize(
        { cols: 120, rows: 34 },
        { cols: 120, rows: 34 },
      ),
    ).toBe(false);
  });

  it("forwards when either dimension changes", () => {
    expect(
      shouldForwardPtyResize(
        { cols: 120, rows: 34 },
        { cols: 121, rows: 34 },
      ),
    ).toBe(true);
    expect(
      shouldForwardPtyResize(
        { cols: 120, rows: 34 },
        { cols: 120, rows: 35 },
      ),
    ).toBe(true);
  });

  it("ignores degenerate sizes", () => {
    expect(
      shouldForwardPtyResize(null, { cols: 0, rows: 24 }),
    ).toBe(false);
    expect(
      shouldForwardPtyResize(null, { cols: 80, rows: 0 }),
    ).toBe(false);
  });
});
