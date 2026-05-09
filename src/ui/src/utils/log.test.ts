// @vitest-environment happy-dom

/// Pin the contract of `log.ts`'s frontend → backend bridge so a
/// silent regression (e.g. someone re-introducing `console.log`
/// mirroring at the default level) shows up in CI instead of as
/// noisy log files in production.
///
/// happy-dom gives us `window`, `console`, and `dispatchEvent`, so
/// the global handlers install for real and we exercise them by
/// dispatching events. The Tauri invoke surface is mocked because
/// we want to verify the payload shape, not the IPC bridge.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  log,
  installFrontendLogBridge,
  setFrontendLogVerbosity,
} from "./log";

describe("log.ts: backend forwarding", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("forwards each level to the log_from_frontend command with the right payload", () => {
    log.error("test", "boom", { code: 42 }, "Error: boom\n  at f");
    expect(invokeMock).toHaveBeenCalledWith("log_from_frontend", {
      payload: {
        level: "error",
        frontend_target: "test",
        message: "boom",
        fields: { code: 42 },
        stack: "Error: boom\n  at f",
      },
    });

    log.info("test", "hello");
    expect(invokeMock).toHaveBeenLastCalledWith("log_from_frontend", {
      payload: {
        level: "info",
        frontend_target: "test",
        message: "hello",
        fields: undefined,
      },
    });
  });

  it("never throws when invoke rejects (we shouldn't be able to log a log-failure)", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("bridge gone"));
    expect(() => log.error("teardown", "x")).not.toThrow();
    // Allow the rejected microtask to flush before the test ends so
    // vitest's unhandled-rejection trip wires don't fire.
    await Promise.resolve();
  });
});

describe("log.ts: window error capture", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    // Re-installing the bridge multiple times across the suite is a
    // no-op after the first call (matches the production guard); the
    // listeners installed on the first `installFrontendLogBridge`
    // remain in place across describe blocks.
    installFrontendLogBridge("errors");
  });

  it("forwards window error events as 'unhandled-error'", () => {
    invokeMock.mockReset();
    const err = new Error("kaboom");
    const event = new ErrorEvent("error", {
      error: err,
      message: err.message,
      filename: "https://example/app.js",
      lineno: 1,
      colno: 2,
    });
    window.dispatchEvent(event);

    expect(invokeMock).toHaveBeenCalledWith(
      "log_from_frontend",
      expect.objectContaining({
        payload: expect.objectContaining({
          level: "error",
          frontend_target: "unhandled-error",
          message: "kaboom",
          stack: err.stack,
        }),
      }),
    );
  });

  it("forwards unhandledrejection events with reason normalized to a string", () => {
    invokeMock.mockReset();
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    Object.assign(event, { reason: "promise blew up" });
    window.dispatchEvent(event);
    expect(invokeMock).toHaveBeenCalledWith(
      "log_from_frontend",
      expect.objectContaining({
        payload: expect.objectContaining({
          level: "error",
          frontend_target: "unhandled-rejection",
          message: "promise blew up",
        }),
      }),
    );
  });
});

describe("log.ts: console verbosity gating", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    installFrontendLogBridge("errors");
  });

  it("mirrors console.error at every verbosity (errors are always captured)", () => {
    setFrontendLogVerbosity("errors");
    invokeMock.mockReset();
    console.error("first");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores console.warn at 'errors' verbosity but mirrors at 'warnings' and 'all'", () => {
    setFrontendLogVerbosity("errors");
    invokeMock.mockReset();
    console.warn("muted");
    expect(invokeMock).not.toHaveBeenCalled();

    setFrontendLogVerbosity("warnings");
    invokeMock.mockReset();
    console.warn("captured");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "log_from_frontend",
      expect.objectContaining({
        payload: expect.objectContaining({
          level: "warn",
          frontend_target: "console-warn",
        }),
      }),
    );

    setFrontendLogVerbosity("all");
    invokeMock.mockReset();
    console.warn("still captured");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("only mirrors console.log/info at 'all' verbosity", () => {
    setFrontendLogVerbosity("warnings");
    invokeMock.mockReset();
    console.log("ignored");
    console.info("ignored");
    expect(invokeMock).not.toHaveBeenCalled();

    setFrontendLogVerbosity("all");
    invokeMock.mockReset();
    console.log("captured");
    console.info("captured");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
