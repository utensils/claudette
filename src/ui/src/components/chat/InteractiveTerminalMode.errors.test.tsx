// @vitest-environment happy-dom

// Failure-mode tests for `InteractiveTerminalMode`. The smoke test (G6)
// proves the happy path; the keystrokes test (F1) proves the on-data /
// resize / dispose plumbing. This file targets the error branches:
//
//   1. `attach` rejection on mount — should log + continue rendering.
//   2. `subscribeOutput` rejection — same: log + continue rendering.
//   3. Unlisten throwing on unmount — unmount must still complete and
//      release the rest of the effect (terminal dispose, RO disconnect).
//   4. Post-unmount race — when `subscribeOutput` resolves AFTER the
//      effect has been torn down, the resolved unlisten must be called
//      immediately so the listener is never leaked.
//
// We reuse the F1-style mocked xterm so we can pin disposal order without
// dragging in xterm.js's renderer, and so we can force `subscribeOutput`
// to resolve on our schedule via a Promise we control.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// ---------- Mocks --------------------------------------------------------

const attachMock = vi.fn(async (_sid: string) => undefined);
const sendInputMock = vi.fn(async (_sid: string, _text: string) => undefined);
const subscribeOutputMock = vi.fn(
  async (_sid: string, _fn: (ev: unknown) => void) => {
    return vi.fn();
  },
);

vi.mock("../../services/interactive", () => ({
  attach: (sid: string) => attachMock(sid),
  sendInput: (sid: string, text: string) => sendInputMock(sid, text),
  subscribeOutput: (sid: string, fn: (ev: unknown) => void) =>
    subscribeOutputMock(sid, fn),
}));

// xterm.css side-effect import — happy-dom doesn't parse stylesheets.
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Minimal Terminal fake. We only need disposal-order recording and a
// container to render into — keystroke forwarding is covered elsewhere.
interface TerminalSpy {
  dataDisposeMock: Mock;
  termDisposeMock: Mock;
  disposeOrder: string[];
}

const terminalSpies: TerminalSpy[] = [];

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    private spy: TerminalSpy;

    constructor(_opts: unknown) {
      const order: string[] = [];
      const spy: TerminalSpy = {
        dataDisposeMock: vi.fn(() => {
          order.push("data");
        }),
        termDisposeMock: vi.fn(() => {
          order.push("term");
        }),
        disposeOrder: order,
      };
      this.spy = spy;
      terminalSpies.push(spy);
    }

    onData(_cb: (data: string) => void) {
      return { dispose: this.spy.dataDisposeMock };
    }

    loadAddon(_addon: unknown) {
      /* no-op */
    }

    open(_container: HTMLElement) {
      /* no-op */
    }

    write(_data: unknown) {
      /* no-op */
    }

    dispose() {
      this.spy.termDisposeMock();
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class FakeFitAddon {
    public fit = vi.fn();
    activate() {
      /* no-op */
    }
    dispose() {
      /* no-op */
    }
  }
  return { FitAddon: FakeFitAddon };
});

// ResizeObserver — disconnect recording lets us pin the post-unmount
// cleanup order even when other paths in the effect throw.
class FakeResizeObserver {
  public disconnectMock = vi.fn();
  constructor(_cb: ResizeObserverCallback) {
    /* no-op */
  }
  observe(_target: Element) {
    /* no-op */
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    this.disconnectMock();
  }
}

// ---------- Harness ------------------------------------------------------

// Import after mocks are registered.
import { InteractiveTerminalMode } from "./InteractiveTerminalMode";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  // Flush microtasks so the `.then(...)` / `.catch(...)` chains run.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

async function unmountAll() {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  // The component logs rejection paths via console.warn — silence the
  // noise while still letting tests assert on call counts.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await unmountAll();
  attachMock.mockReset();
  attachMock.mockImplementation(async () => undefined);
  sendInputMock.mockReset();
  sendInputMock.mockImplementation(async () => undefined);
  subscribeOutputMock.mockReset();
  subscribeOutputMock.mockImplementation(async () => vi.fn());
  terminalSpies.length = 0;
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

// ---------- Tests --------------------------------------------------------

describe("InteractiveTerminalMode failure paths", () => {
  it("logs and keeps rendering when `attach` rejects on mount", async () => {
    attachMock.mockRejectedValueOnce(new Error("attach boom"));

    const container = await render(<InteractiveTerminalMode sid="sid-att" />);

    // The xterm container element is created synchronously in the
    // effect (we mocked `open` to a no-op so there's no `.xterm`
    // sentinel — instead we look for the wrapper div the component
    // owns).
    expect(
      container.querySelector('[data-testid="interactive-terminal-mode"]'),
    ).not.toBeNull();

    // The catch handler in the effect should have routed the failure
    // through console.warn — that's what proves we caught the
    // rejection instead of letting it surface as unhandledrejection.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("attach failed"),
      expect.any(Error),
    );
    // The terminal mount should NOT have been aborted by the failure.
    expect(terminalSpies).toHaveLength(1);
  });

  it("logs and keeps rendering when `subscribeOutput` rejects", async () => {
    subscribeOutputMock.mockRejectedValueOnce(new Error("subscribe boom"));

    const container = await render(<InteractiveTerminalMode sid="sid-sub" />);

    expect(
      container.querySelector('[data-testid="interactive-terminal-mode"]'),
    ).not.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("subscribeOutput failed"),
      expect.any(Error),
    );
    // The mount completed — terminal and (regardless of subscription
    // failure) the rest of the effect ran.
    expect(terminalSpies).toHaveLength(1);
  });

  it("completes unmount cleanly when the unlisten function throws", async () => {
    const throwingUnlisten = vi.fn(() => {
      throw new Error("unlisten boom");
    });
    subscribeOutputMock.mockImplementationOnce(async () => throwingUnlisten);

    await render(<InteractiveTerminalMode sid="sid-unl" />);

    expect(terminalSpies).toHaveLength(1);
    const spy = terminalSpies[0]!;

    // Unmount must not propagate the unlisten throw — otherwise React
    // logs an "uncaught error in cleanup" and downstream cleanup
    // (terminal dispose) silently leaks.
    await expect(unmountAll()).resolves.toBeUndefined();

    // The unlisten was attempted and the terminal was still disposed.
    expect(throwingUnlisten).toHaveBeenCalledTimes(1);
    expect(spy.termDisposeMock).toHaveBeenCalledTimes(1);
    expect(spy.dataDisposeMock).toHaveBeenCalledTimes(1);
  });

  it("calls the resolved unlisten immediately when `subscribeOutput` settles after unmount", async () => {
    // Hold the subscribeOutput promise open across the unmount so we
    // can race the resolution against effect teardown.
    const lateUnlisten = vi.fn();
    let resolveUnlisten: ((u: typeof lateUnlisten) => void) | null = null;
    const pending = new Promise<typeof lateUnlisten>((resolve) => {
      resolveUnlisten = resolve;
    });
    subscribeOutputMock.mockImplementationOnce(() => pending);

    // Mount, then unmount BEFORE the subscribeOutput promise resolves.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InteractiveTerminalMode sid="sid-race" />);
    });

    // Unmount before resolving — sets the effect's `cancelled` flag.
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The component should not have attached the unlisten yet.
    expect(lateUnlisten).not.toHaveBeenCalled();

    // Now resolve the held subscribeOutput promise. The `.then` chain
    // in the component should fire its `cancelled` branch and invoke
    // the unlisten immediately so the listener does not leak.
    await act(async () => {
      resolveUnlisten!(lateUnlisten);
      // Two microtask drains: one for the `.then`, one for any
      // chained handler in the component.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lateUnlisten).toHaveBeenCalledTimes(1);
  });
});
