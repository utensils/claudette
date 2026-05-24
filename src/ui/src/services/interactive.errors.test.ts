import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// Same capture-style mocks as `interactive.test.ts`, but tuned for the
// rejection path: `invoke` is set up to reject with a known error per
// test, and `listen` is rejectable so we can verify that subscribers
// surface the failure to the caller (and that no double-unlisten
// happens when registration itself failed).

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

type ListenHandler = (event: { payload: unknown }) => void;
const listenMock = vi.fn();
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: ListenHandler) =>
    listenMock(eventName, handler),
}));

import {
  attach,
  cleanupOrphans,
  stopInteractive,
  subscribeOutput,
} from "./interactive";

// ---------------------------------------------------------------------------
// Command rejection paths
// ---------------------------------------------------------------------------

describe("interactive service — command rejection paths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    unlistenSpy.mockReset();
  });

  it("attach propagates the invoke rejection to the caller verbatim", async () => {
    // Sentinel object identity so we can assert the exact Error reaches
    // the caller — i.e. nothing in `attach` swallows or rewraps it. The
    // production code is a one-line `invoke` wrapper, so this regression
    // pin will catch a future maintainer adding a `.catch(...)` that
    // breaks UI error surfacing.
    const boom = new Error("attach failed: sid not found");
    invokeMock.mockRejectedValueOnce(boom);

    await expect(attach("S-1")).rejects.toBe(boom);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("interactive_attach", {
      sid: "S-1",
    });
  });

  it("stopInteractive propagates the invoke rejection to the caller verbatim", async () => {
    const boom = new Error("stop failed: host unavailable");
    invokeMock.mockRejectedValueOnce(boom);

    await expect(stopInteractive("S-1", true)).rejects.toBe(boom);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("interactive_stop", {
      sid: "S-1",
      force: true,
    });
  });

  it("cleanupOrphans propagates the invoke rejection to the caller verbatim", async () => {
    const boom = new Error("cleanup_orphans failed: db locked");
    invokeMock.mockRejectedValueOnce(boom);

    await expect(cleanupOrphans()).rejects.toBe(boom);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    // No payload — the Rust command takes no args.
    expect(invokeMock).toHaveBeenCalledWith(
      "interactive_cleanup_orphans",
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Subscription registration rejection
// ---------------------------------------------------------------------------

describe("interactive service — subscribeOutput rejection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    unlistenSpy.mockReset();
  });

  it("rejects the caller's promise when listen() rejects and does not call unlisten", async () => {
    // Simulate the Tauri event plugin failing to register the listener
    // (e.g. the underlying IPC channel is closed during teardown). The
    // production code returns the `listen(...)` promise directly, so
    // the caller receives the rejection.
    const boom = new Error("listen failed: channel closed");
    listenMock.mockRejectedValueOnce(boom);

    await expect(
      subscribeOutput("S-1", () => {
        // Body shouldn't matter — the registration failed before any
        // event could be dispatched.
      }),
    ).rejects.toBe(boom);

    // Registration was attempted exactly once on the per-sid output
    // topic and never returned an unlisten handle, so nothing should
    // have called unlisten — there's no handle to call. This guards
    // against a future maintainer wrapping `listen(...)` in a
    // `try/finally` that calls a stale unlisten.
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith(
      "interactive://S-1/output",
      expect.any(Function),
    );
    expect(unlistenSpy).not.toHaveBeenCalled();
  });
});
