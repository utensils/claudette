import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// Capture-style mocks for both invoke (commands) and listen (events) so
// individual tests can assert the literal Tauri command name + arg shape
// and replay a fake event payload through the registered listener.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

type ListenHandler = (event: { payload: unknown }) => void;
const listeners = new Map<string, ListenHandler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: ListenHandler) => {
    const list = listeners.get(eventName) ?? [];
    list.push(handler);
    listeners.set(eventName, list);
    return Promise.resolve(() => {
      const after =
        listeners.get(eventName)?.filter((h) => h !== handler) ?? [];
      listeners.set(eventName, after);
    });
  },
}));

import {
  attach,
  captureScreen,
  type HookEvent,
  listInteractive,
  normalizeHookPayload,
  type OutputEvent,
  sendInput,
  startInteractive,
  type StartInteractiveArgs,
  stopInteractive,
  subscribeExit,
  subscribeHooks,
  subscribeOutput,
  subscribeStreamError,
} from "./interactive";

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

describe("interactive service — commands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
  });

  it("startInteractive invokes interactive_start with the camelCase args object", async () => {
    invokeMock.mockResolvedValueOnce({ sid: "S-1", hostKind: "tmux" });

    const args: StartInteractiveArgs = {
      workspaceId: "ws-1",
      workingDir: "/tmp/ws-1",
      rows: 24,
      cols: 80,
      claudeBinary: "/usr/local/bin/claude",
      claudeArgs: ["--print", "--output-format", "stream-json"],
    };
    const out = await startInteractive(args);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("interactive_start", { args });
    expect(out).toEqual({ sid: "S-1", hostKind: "tmux" });
  });

  it("sendInput invokes interactive_send_input with sid + text", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await sendInput("S-1", "hello world");

    expect(invokeMock).toHaveBeenCalledWith("interactive_send_input", {
      sid: "S-1",
      text: "hello world",
    });
  });

  it("captureScreen invokes interactive_capture_screen and returns the base64 string", async () => {
    invokeMock.mockResolvedValueOnce("YWJjZA==");

    const ansiB64 = await captureScreen("S-1");

    expect(invokeMock).toHaveBeenCalledWith("interactive_capture_screen", {
      sid: "S-1",
    });
    expect(ansiB64).toBe("YWJjZA==");
  });

  it("stopInteractive defaults force=false", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await stopInteractive("S-1");

    expect(invokeMock).toHaveBeenCalledWith("interactive_stop", {
      sid: "S-1",
      force: false,
    });
  });

  it("stopInteractive passes force=true when requested", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await stopInteractive("S-1", true);

    expect(invokeMock).toHaveBeenCalledWith("interactive_stop", {
      sid: "S-1",
      force: true,
    });
  });

  it("attach invokes interactive_attach with sid", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await attach("S-1");

    expect(invokeMock).toHaveBeenCalledWith("interactive_attach", {
      sid: "S-1",
    });
  });

  it("listInteractive invokes interactive_list_for_workspace with workspaceId", async () => {
    invokeMock.mockResolvedValueOnce([]);

    const rows = await listInteractive("ws-1");

    expect(invokeMock).toHaveBeenCalledWith("interactive_list_for_workspace", {
      workspaceId: "ws-1",
    });
    expect(rows).toEqual([]);
  });

  it("listInteractive returns rows with the persisted camelCase shape", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        sid: "S-1",
        workspaceId: "ws-1",
        hostKind: "tmux",
        state: "running",
        crashReason: null,
        createdAt: "2026-05-16T22:00:00Z",
        lastAttachedAt: null,
        lastScreenBlob: null,
        claudeFlagsJson: "[]",
        pid: null,
      },
    ]);

    const rows = await listInteractive("ws-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].sid).toBe("S-1");
    expect(rows[0].state).toBe("running");
    expect(rows[0].lastScreenBlob).toBeNull();
  });

  it("propagates errors from invoke so callers can surface them", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Claude Interactive is disabled"));

    await expect(sendInput("S-1", "x")).rejects.toThrow(
      "Claude Interactive is disabled",
    );
  });
});

// ---------------------------------------------------------------------------
// Output subscription
// ---------------------------------------------------------------------------

describe("interactive service — subscribeOutput", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
  });

  it("registers a listener on the per-sid output topic and unwraps the payload", async () => {
    const received: OutputEvent[] = [];
    await subscribeOutput("S-1", (ev) => received.push(ev));

    const handlers = listeners.get("interactive://S-1/output");
    expect(handlers).toHaveLength(1);

    handlers?.[0]({
      payload: { sid: "S-1", bytesB64: "QQ==", seq: 1 },
    });

    expect(received).toEqual([{ sid: "S-1", bytesB64: "QQ==", seq: 1 }]);
  });

  it("returns an unlisten function that detaches the handler", async () => {
    const unlisten = await subscribeOutput("S-1", () => {});
    expect(listeners.get("interactive://S-1/output")).toHaveLength(1);

    unlisten();

    expect(listeners.get("interactive://S-1/output") ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hook payload normalization (the F3 divergence)
// ---------------------------------------------------------------------------

describe("interactive service — normalizeHookPayload", () => {
  it("collapses the flat CLI-relayed shape verbatim for known kinds", () => {
    expect(
      normalizeHookPayload({ sid: "S-1", kind: "stop" }),
    ).toEqual<HookEvent>({ sid: "S-1", kind: "stop" });

    expect(
      normalizeHookPayload({
        sid: "S-1",
        kind: "awaiting",
        reason: "permission",
      }),
    ).toEqual<HookEvent>({
      sid: "S-1",
      kind: "awaiting",
      reason: "permission",
    });
  });

  it("collapses the nested attach-stream shape (HookPayload { sid, hook: HookFired })", () => {
    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "stop" },
      }),
    ).toEqual<HookEvent>({ sid: "S-1", kind: "stop" });

    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "awaiting", reason: "permission" },
      }),
    ).toEqual<HookEvent>({
      sid: "S-1",
      kind: "awaiting",
      reason: "permission",
    });

    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "prompt_submitted" },
      }),
    ).toEqual<HookEvent>({ sid: "S-1", kind: "prompt_submitted" });

    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "subagent_stop" },
      }),
    ).toEqual<HookEvent>({ sid: "S-1", kind: "subagent_stop" });
  });

  it("treats the nested null reason as absent", () => {
    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "awaiting", reason: null },
      }),
    ).toEqual<HookEvent>({ sid: "S-1", kind: "awaiting" });
  });

  it("maps unknown kinds to 'unknown' and surfaces the original label as reason", () => {
    // CLI-relayed: `kind_to_wire` passes the raw_kind string through for
    // HookEventKind::Unknown.
    expect(
      normalizeHookPayload({ sid: "S-1", kind: "FutureHook" }),
    ).toEqual<HookEvent>({
      sid: "S-1",
      kind: "unknown",
      reason: "FutureHook",
    });

    // Attach-stream: HookFired::Unknown serializes with kind="unknown" and
    // carries raw_kind. We surface that as reason so logs can label the drift.
    expect(
      normalizeHookPayload({
        sid: "S-1",
        hook: { kind: "unknown", raw_kind: "FutureHook", raw_payload: "{}" },
      }),
    ).toEqual<HookEvent>({
      sid: "S-1",
      kind: "unknown",
      reason: "FutureHook",
    });
  });

  it("preserves the original kind label as reason for flat-path unknown kinds", () => {
    expect(
      normalizeHookPayload({ sid: "S-2", kind: "SomeFutureHookName" }),
    ).toEqual<HookEvent>({
      sid: "S-2",
      kind: "unknown",
      reason: "SomeFutureHookName",
    });
  });

  it("normalizes both shapes to an identical HookEvent for the same logical hook", () => {
    const flat = normalizeHookPayload({
      sid: "S-1",
      kind: "awaiting",
      reason: "blocked on permission",
    });
    const nested = normalizeHookPayload({
      sid: "S-1",
      hook: { kind: "awaiting", reason: "blocked on permission" },
    });
    expect(flat).toEqual(nested);
  });
});

// ---------------------------------------------------------------------------
// Hook subscription
// ---------------------------------------------------------------------------

describe("interactive service — subscribeHooks", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
  });

  it("normalizes the flat CLI-relayed payload through the registered listener", async () => {
    const received: HookEvent[] = [];
    await subscribeHooks("S-1", (ev) => received.push(ev));

    const handlers = listeners.get("interactive://S-1/hook");
    expect(handlers).toHaveLength(1);

    handlers?.[0]({
      payload: { sid: "S-1", kind: "awaiting", reason: "permission" },
    });

    expect(received).toEqual([
      { sid: "S-1", kind: "awaiting", reason: "permission" },
    ]);
  });

  it("normalizes the nested attach-stream payload through the registered listener", async () => {
    const received: HookEvent[] = [];
    await subscribeHooks("S-1", (ev) => received.push(ev));

    const handlers = listeners.get("interactive://S-1/hook");
    handlers?.[0]({
      payload: {
        sid: "S-1",
        hook: { kind: "awaiting", reason: "permission" },
      },
    });

    expect(received).toEqual([
      { sid: "S-1", kind: "awaiting", reason: "permission" },
    ]);
  });

  it("delivers identical HookEvents regardless of which F3 payload shape arrives", async () => {
    const received: HookEvent[] = [];
    await subscribeHooks("S-1", (ev) => received.push(ev));

    const handlers = listeners.get("interactive://S-1/hook");
    handlers?.[0]({
      payload: { sid: "S-1", kind: "stop" },
    });
    handlers?.[0]({
      payload: { sid: "S-1", hook: { kind: "stop" } },
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(received[1]);
  });
});

// ---------------------------------------------------------------------------
// Exit + error subscriptions
// ---------------------------------------------------------------------------

describe("interactive service — subscribeExit / subscribeStreamError", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
  });

  it("subscribeExit listens on the per-sid exit topic", async () => {
    const seen: unknown[] = [];
    await subscribeExit("S-1", (ev) => seen.push(ev));

    const handlers = listeners.get("interactive://S-1/exit");
    expect(handlers).toHaveLength(1);

    handlers?.[0]({
      payload: { sid: "S-1", exitStatus: 0, reason: "exited" },
    });

    expect(seen).toEqual([{ sid: "S-1", exitStatus: 0, reason: "exited" }]);
  });

  it("subscribeStreamError listens on the per-sid error topic", async () => {
    const seen: unknown[] = [];
    await subscribeStreamError("S-1", (ev) => seen.push(ev));

    const handlers = listeners.get("interactive://S-1/error");
    expect(handlers).toHaveLength(1);

    handlers?.[0]({
      payload: { sid: "S-1", message: "boom", recoverable: false },
    });

    expect(seen).toEqual([
      { sid: "S-1", message: "boom", recoverable: false },
    ]);
  });
});
