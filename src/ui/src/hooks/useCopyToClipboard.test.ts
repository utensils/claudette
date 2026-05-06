import { describe, expect, it } from "vitest";
import { resolveCopySource } from "./useCopyToClipboard";

describe("resolveCopySource", () => {
  it("returns the literal string", async () => {
    expect(await resolveCopySource("hello")).toBe("hello");
  });

  it("calls a sync thunk and returns its string", async () => {
    expect(await resolveCopySource(() => "sync result")).toBe("sync result");
  });

  it("awaits an async thunk and returns the resolved string", async () => {
    expect(
      await resolveCopySource(async () => "async result"),
    ).toBe("async result");
  });

  it("returns null for an empty string source", async () => {
    expect(await resolveCopySource("")).toBeNull();
  });

  it("returns null when a thunk resolves to null", async () => {
    // Callers (DiffViewer, FileViewer) signal "intentionally invalid" by
    // returning null from their content-fetch thunk. This must not surface
    // as a thrown error — it should flow through as a silent error state.
    expect(await resolveCopySource(() => null)).toBeNull();
    expect(await resolveCopySource(async () => null)).toBeNull();
  });

  it("returns null when a thunk resolves to an empty string", async () => {
    expect(await resolveCopySource(() => "")).toBeNull();
  });

  it("propagates errors thrown by a sync thunk", async () => {
    await expect(
      resolveCopySource(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("propagates errors rejected by an async thunk", async () => {
    await expect(
      resolveCopySource(async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
  });
});
