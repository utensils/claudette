// @vitest-environment happy-dom

// Unit tests for G4's pure reducer and the hook's subscription wiring.
// The bulk of the coverage targets `assemblerReducer` directly — it's
// a pure function so it can be driven without React/Tauri. We add a
// single integration-style test that mocks the three G3 subscribe
// helpers to confirm the hook actually plumbs events through to the
// reducer.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  assemblerReducer,
  initialAssemblerState,
  type AssemblerEvent,
  type AssemblerState,
} from "./useInteractiveTurnAssembler";

// ---------------------------------------------------------------------------
// Small fixture helpers — keep the test bodies focused on assertions.
// ---------------------------------------------------------------------------

function bytes(str: string): Uint8Array {
  // TextEncoder is part of the lib types in tsconfig.app.json and
  // exists in both the node and happy-dom test environments vitest
  // uses, so this works without extra polyfills.
  return new TextEncoder().encode(str);
}

function output(str: string, seq = 0): AssemblerEvent {
  return { type: "output", bytes: bytes(str), seq };
}

function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

function reduce(
  initial: AssemblerState,
  events: AssemblerEvent[],
): AssemblerState {
  return events.reduce(assemblerReducer, initial);
}

// ---------------------------------------------------------------------------
// Reducer tests
// ---------------------------------------------------------------------------

describe("useInteractiveTurnAssembler reducer", () => {
  it("emits a turn on Stop with the spec-defined id numbering", () => {
    // Feed pre-prompt output first so the transient "turn 0" exists,
    // then run the prompt → output → stop sequence. That way the
    // post-prompt turn is unambiguously id=1, which pins the contract
    // (transient pre-prompt turn = 0; first user-submitted turn = 1).
    const state = reduce(initialAssemblerState, [
      output("welcome banner"),
      { type: "hook", kind: "prompt_submitted" },
      output("hello "),
      output("world"),
      { type: "hook", kind: "stop" },
    ]);

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0].id).toBe(0);
    expect(state.turns[0].status).toBe("done"); // closed by prompt_submitted
    expect(decode(state.turns[0].bytes)).toBe("welcome banner");
    expect(state.turns[1].id).toBe(1);
    expect(state.turns[1].status).toBe("done");
    expect(decode(state.turns[1].bytes)).toBe("hello world");
    expect(state.awaitingInput).toBe(false);
    expect(state.crashed).toBe(false);
  });

  it("resets accumulated state on a reset event", () => {
    const before = reduce(initialAssemblerState, [
      { type: "hook", kind: "prompt_submitted" },
      output("hello"),
      { type: "hook", kind: "awaiting" },
    ]);
    expect(before.turns).toHaveLength(1);
    expect(before.awaitingInput).toBe(true);

    const after = assemblerReducer(before, { type: "reset" });
    expect(after).toBe(initialAssemblerState);
    expect(after.turns).toEqual([]);
    expect(after.awaitingInput).toBe(false);
    expect(after.crashed).toBe(false);
  });

  it("preserves pre-prompt output as a transient turn 0", () => {
    // The very first output before any `prompt_submitted` should not
    // be dropped — it carries Claude's splash / banner.
    const state = reduce(initialAssemblerState, [
      output("welcome banner"),
      { type: "hook", kind: "prompt_submitted" },
      output("answer"),
      { type: "hook", kind: "stop" },
    ]);

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0].id).toBe(0);
    expect(decode(state.turns[0].bytes)).toBe("welcome banner");
    expect(state.turns[0].status).toBe("done"); // closed by next prompt
    expect(state.turns[1].id).toBe(1);
    expect(decode(state.turns[1].bytes)).toBe("answer");
    expect(state.turns[1].status).toBe("done");
  });

  it("clears awaiting badge when UserPromptSubmit fires", () => {
    const afterAwaiting = reduce(initialAssemblerState, [
      { type: "hook", kind: "prompt_submitted" },
      output("waiting on you..."),
      { type: "hook", kind: "awaiting" },
    ]);
    expect(afterAwaiting.awaitingInput).toBe(true);

    const afterSubmit = assemblerReducer(afterAwaiting, {
      type: "hook",
      kind: "prompt_submitted",
    });
    expect(afterSubmit.awaitingInput).toBe(false);
    // Previous turn was closed, a new live one opened.
    expect(afterSubmit.turns).toHaveLength(2);
    expect(afterSubmit.turns[0].status).toBe("done");
    expect(afterSubmit.turns[1].status).toBe("live");
  });

  it("ignores duplicate awaiting events", () => {
    const first = assemblerReducer(initialAssemblerState, {
      type: "hook",
      kind: "awaiting",
    });
    expect(first.awaitingInput).toBe(true);

    // Same reference means React can bail on the re-render.
    const second = assemblerReducer(first, {
      type: "hook",
      kind: "awaiting",
    });
    expect(second).toBe(first);
  });

  it("flips to crashed state on Exit event", () => {
    const state = reduce(initialAssemblerState, [
      { type: "hook", kind: "prompt_submitted" },
      output("partial answer"),
      { type: "exit", reason: "signal: SIGKILL" },
    ]);

    expect(state.crashed).toBe(true);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].status).toBe("crashed");
    expect(decode(state.turns[0].bytes)).toBe("partial answer");
  });

  it("falls back to raw_kind for unknown hooks (logs and no-ops)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = reduce(initialAssemblerState, [
        { type: "hook", kind: "prompt_submitted" },
        output("partial"),
      ]);
      // Unknown kind must not perturb the turns list or aux state.
      const after = assemblerReducer(before, {
        type: "hook",
        kind: "unknown",
        reason: "SomeFutureHook",
      });

      expect(after.turns).toBe(before.turns);
      expect(after.awaitingInput).toBe(before.awaitingInput);
      expect(after.crashed).toBe(before.crashed);
      expect(warn).toHaveBeenCalledWith(
        "[interactive] ignoring unknown hook kind:",
        "SomeFutureHook",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("subagent_stop is a no-op in v1", () => {
    const before = reduce(initialAssemblerState, [
      { type: "hook", kind: "prompt_submitted" },
      output("orchestrator output"),
    ]);
    const after = assemblerReducer(before, {
      type: "hook",
      kind: "subagent_stop",
    });
    // Same reference — no visible state change.
    expect(after).toBe(before);
  });

  it("stop with no live turn is a no-op", () => {
    const after = assemblerReducer(initialAssemblerState, {
      type: "hook",
      kind: "stop",
    });
    expect(after).toBe(initialAssemblerState);
  });
});

// ---------------------------------------------------------------------------
// Hook integration test — confirms wiring through to the reducer.
// ---------------------------------------------------------------------------

type OutputHandler = (ev: { sid: string; bytesB64: string; seq: number }) => void;
type HookHandler = (ev: {
  sid: string;
  kind:
    | "stop"
    | "awaiting"
    | "prompt_submitted"
    | "subagent_stop"
    | "unknown";
  reason?: string;
}) => void;
type ExitHandler = (ev: { sid: string; exitStatus: number; reason: string }) => void;

const harness = {
  outputHandlers: [] as OutputHandler[],
  hookHandlers: [] as HookHandler[],
  exitHandlers: [] as ExitHandler[],
  unlistens: [] as Array<ReturnType<typeof vi.fn>>,
};

vi.mock("../services/interactive", () => ({
  subscribeOutput: vi.fn((_sid: string, fn: OutputHandler) => {
    harness.outputHandlers.push(fn);
    const unlisten = vi.fn();
    harness.unlistens.push(unlisten);
    return Promise.resolve(unlisten);
  }),
  subscribeHooks: vi.fn((_sid: string, fn: HookHandler) => {
    harness.hookHandlers.push(fn);
    const unlisten = vi.fn();
    harness.unlistens.push(unlisten);
    return Promise.resolve(unlisten);
  }),
  subscribeExit: vi.fn((_sid: string, fn: ExitHandler) => {
    harness.exitHandlers.push(fn);
    const unlisten = vi.fn();
    harness.unlistens.push(unlisten);
    return Promise.resolve(unlisten);
  }),
}));

beforeEach(() => {
  harness.outputHandlers = [];
  harness.hookHandlers = [];
  harness.exitHandlers = [];
  harness.unlistens = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useInteractiveTurnAssembler hook wiring", () => {
  it("subscribes to all three event streams when a sid is provided", async () => {
    // Use renderHook from @testing-library/react if available; otherwise
    // fall back to a small manual mount via react-dom/client. The
    // codebase's existing tests use the manual mount pattern, so we
    // mirror that here to avoid pulling in another dep.
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { useInteractiveTurnAssembler } = await import(
      "./useInteractiveTurnAssembler"
    );

    let capturedState: ReturnType<typeof useInteractiveTurnAssembler> | null =
      null;

    function Probe({ sid }: { sid: string | null }) {
      capturedState = useInteractiveTurnAssembler(sid);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(Probe, { sid: "sid-1" }));
      });

      // Subscriptions registered via the mocked module.
      expect(harness.outputHandlers).toHaveLength(1);
      expect(harness.hookHandlers).toHaveLength(1);
      expect(harness.exitHandlers).toHaveLength(1);

      // Drive a small scripted exchange through the handlers and
      // confirm the reducer state visible to React reflects it.
      await act(async () => {
        harness.hookHandlers[0]({
          sid: "sid-1",
          kind: "prompt_submitted",
        });
        // bytesB64 for "hi" in base64 is "aGk=".
        harness.outputHandlers[0]({
          sid: "sid-1",
          bytesB64: "aGk=",
          seq: 1,
        });
        harness.hookHandlers[0]({ sid: "sid-1", kind: "stop" });
      });

      expect(capturedState).not.toBeNull();
      const state = capturedState as unknown as AssemblerState;
      expect(state.turns).toHaveLength(1);
      expect(state.turns[0].status).toBe("done");
      expect(decode(state.turns[0].bytes)).toBe("hi");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }

    // Cleanup invoked all three unlisten functions.
    for (const u of harness.unlistens) {
      expect(u).toHaveBeenCalledTimes(1);
    }
  });

  it("resets accumulated state when sid changes", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const React = await import("react");
    const { useInteractiveTurnAssembler } = await import(
      "./useInteractiveTurnAssembler"
    );

    let capturedState: ReturnType<typeof useInteractiveTurnAssembler> | null =
      null;

    function Probe({ sid }: { sid: string | null }) {
      capturedState = useInteractiveTurnAssembler(sid);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      // Mount with sid-A and accumulate a finished turn.
      await act(async () => {
        root.render(React.createElement(Probe, { sid: "sid-A" }));
      });

      expect(harness.outputHandlers).toHaveLength(1);
      expect(harness.hookHandlers).toHaveLength(1);

      await act(async () => {
        harness.hookHandlers[0]({
          sid: "sid-A",
          kind: "prompt_submitted",
        });
        // "ok" -> base64 "b2s="
        harness.outputHandlers[0]({
          sid: "sid-A",
          bytesB64: "b2s=",
          seq: 1,
        });
        harness.hookHandlers[0]({ sid: "sid-A", kind: "stop" });
      });

      {
        const state = capturedState as unknown as AssemblerState;
        expect(state.turns).toHaveLength(1);
        expect(decode(state.turns[0].bytes)).toBe("ok");
      }

      // Re-render with sid-B. The hook should dispatch a reset before
      // re-subscribing, so the assembled turn list goes back to empty.
      await act(async () => {
        root.render(React.createElement(Probe, { sid: "sid-B" }));
      });

      {
        const state = capturedState as unknown as AssemblerState;
        expect(state.turns).toEqual([]);
        expect(state.awaitingInput).toBe(false);
        expect(state.crashed).toBe(false);
      }

      // Re-render with null (deselect) — state stays empty.
      await act(async () => {
        root.render(React.createElement(Probe, { sid: null }));
      });

      {
        const state = capturedState as unknown as AssemblerState;
        expect(state.turns).toEqual([]);
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
