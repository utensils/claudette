import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stub the worker constructor so the highlight module's `?worker` import
// resolves to a controllable fake. The fake records postMessage payloads
// and exposes hooks tests can use to deliver responses or simulate failures.
//
// vi.mock factories are hoisted above all imports, so the FakeWorker class
// is defined inside vi.hoisted() to share module state with the test body.
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static reset(): void {
      FakeWorker.instances = [];
    }
    posted: Array<{ id: number; code: string; lang: string }> = [];
    listeners: Record<string, ((e: MessageEvent | ErrorEvent) => void)[]> = {};
    terminated = false;

    constructor() {
      FakeWorker.instances.push(this);
    }

    postMessage(msg: { id: number; code: string; lang: string }): void {
      this.posted.push(msg);
    }

    addEventListener(
      type: string,
      fn: (e: MessageEvent | ErrorEvent) => void,
    ): void {
      (this.listeners[type] ??= []).push(fn);
    }

    terminate(): void {
      this.terminated = true;
    }

    respond(id: number, html: string | null): void {
      const e = { data: { id, html } } as MessageEvent;
      for (const fn of this.listeners.message ?? []) fn(e);
    }

    fail(): void {
      const e = new Event("error") as ErrorEvent;
      for (const fn of this.listeners.error ?? []) fn(e);
    }
  }
  return { FakeWorker };
});

vi.mock("../workers/highlight.worker?worker", () => ({
  default: FakeWorker,
}));

import { highlightCode, getCachedHighlight, __testing } from "./highlight";

beforeEach(() => {
  __testing.reset();
  FakeWorker.reset();
});

afterEach(() => {
  __testing.reset();
  FakeWorker.reset();
});

describe("highlightCode", () => {
  it("does not construct a Worker until the first call", () => {
    expect(FakeWorker.instances).toHaveLength(0);
    expect(getCachedHighlight("x", "ts")).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("dispatches to the worker on the first request and resolves on response", async () => {
    const promise = highlightCode("const x = 1", "ts");
    expect(FakeWorker.instances).toHaveLength(1);
    const w = FakeWorker.instances[0]!;
    expect(w.posted).toEqual([{ id: 0, code: "const x = 1", lang: "ts" }]);
    w.respond(0, "<span>ok</span>");
    await expect(promise).resolves.toBe("<span>ok</span>");
  });

  it("serves cache hits without a second postMessage", async () => {
    const p1 = highlightCode("a", "ts");
    const w = FakeWorker.instances[0]!;
    w.respond(0, "<span>a</span>");
    await p1;
    expect(w.posted).toHaveLength(1);

    const cached = getCachedHighlight("a", "ts");
    expect(cached).toBe("<span>a</span>");

    const p2 = highlightCode("a", "ts");
    await expect(p2).resolves.toBe("<span>a</span>");
    expect(w.posted).toHaveLength(1);
  });

  it("normalizes trailing newline so 'foo\\n' and 'foo' share a cache entry", async () => {
    const p1 = highlightCode("foo\n", "ts");
    const w = FakeWorker.instances[0]!;
    expect(w.posted[0]!.code).toBe("foo");
    w.respond(0, "<span>foo</span>");
    await p1;

    expect(getCachedHighlight("foo", "ts")).toBe("<span>foo</span>");
    expect(getCachedHighlight("foo\n\n", "ts")).toBe("<span>foo</span>");

    const p2 = highlightCode("foo", "ts");
    await expect(p2).resolves.toBe("<span>foo</span>");
    expect(w.posted).toHaveLength(1);
  });

  it("evicts the oldest entry past the LRU cap of 500", async () => {
    for (let i = 0; i < 501; i++) {
      const p = highlightCode(`code-${i}`, "ts");
      const w = FakeWorker.instances[0]!;
      w.respond(i, `<span>${i}</span>`);
      await p;
    }
    expect(__testing.cache.size).toBe(500);
    expect(getCachedHighlight("code-0", "ts")).toBeNull();
    expect(getCachedHighlight("code-500", "ts")).toBe("<span>500</span>");
  });

  it("resolves all pending requests with null and rebuilds the worker on error", async () => {
    const p1 = highlightCode("a", "ts");
    const p2 = highlightCode("b", "ts");
    const w1 = FakeWorker.instances[0]!;
    expect(FakeWorker.instances).toHaveLength(1);
    w1.fail();
    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    expect(w1.terminated).toBe(true);

    const p3 = highlightCode("c", "ts");
    expect(FakeWorker.instances).toHaveLength(2);
    const w2 = FakeWorker.instances[1]!;
    w2.respond(2, "<span>c</span>");
    await expect(p3).resolves.toBe("<span>c</span>");
  });

  it("does not pollute the cache with null responses", async () => {
    const p = highlightCode("bad", "ts");
    const w = FakeWorker.instances[0]!;
    w.respond(0, null);
    await expect(p).resolves.toBeNull();
    expect(getCachedHighlight("bad", "ts")).toBeNull();
  });
});
