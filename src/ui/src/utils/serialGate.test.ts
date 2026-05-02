import { describe, expect, it, vi } from "vitest";

import { createSerialGate } from "./serialGate";

describe("createSerialGate", () => {
  it("returns the underlying result for the first call", async () => {
    const gate = createSerialGate();
    const result = await gate.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("returns null and does not invoke the fn for concurrent calls", async () => {
    const gate = createSerialGate();
    let resolveFirst!: (value: string) => void;
    const fn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolveFirst = r;
          }),
      )
      .mockResolvedValue("second");

    const first = gate.run(fn);
    const second = gate.run(fn);
    const third = gate.run(fn);

    expect(await second).toBeNull();
    expect(await third).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFirst("first");
    expect(await first).toBe("first");
  });

  it("releases the gate after a successful call", async () => {
    const gate = createSerialGate();
    const fn = vi.fn(async () => "x");
    expect(await gate.run(fn)).toBe("x");
    expect(await gate.run(fn)).toBe("x");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("releases the gate after a rejected call so the next click can retry", async () => {
    const gate = createSerialGate();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    await expect(gate.run(fn)).rejects.toThrow("boom");
    expect(await gate.run(fn)).toBe("ok");
  });

  it("isPending tracks the gate state across the call lifecycle", async () => {
    const gate = createSerialGate();
    expect(gate.isPending()).toBe(false);

    let release!: () => void;
    const promise = gate.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    expect(gate.isPending()).toBe(true);

    release();
    await promise;
    expect(gate.isPending()).toBe(false);
  });
});
