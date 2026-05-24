// @vitest-environment happy-dom

// Focused tests for the keystroke + layout plumbing inside
// `InteractiveTerminalMode`. These complement the existing smoke test,
// which runs against the real xterm.js. Here we swap `@xterm/xterm` and
// `@xterm/addon-fit` for fakes so we can:
//   - capture the `onData` handler registered on the terminal and assert
//     that invoking it routes through the G3 `sendInput` service;
//   - capture the `ResizeObserver` callback and verify that container
//     reshapes re-run `fit.fit()`;
//   - observe disposal order on unmount — the audit calls out that the
//     `onData` disposable must be disposed BEFORE the terminal itself.
//
// Mocking the Terminal class is necessary because xterm's real
// `Terminal.dispose()` does not expose call-order to assertions and
// `onData` is registered against the renderer, not the public surface.
// A fake gives us precise visibility into both.

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

// xterm.css side-effect import in the component would try to read a
// stylesheet; stub it out so happy-dom doesn't choke.
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Terminal fake. We record the most-recently-constructed instance on a
// module-level slot so the test can grab the data handler / disposers.
interface TerminalSpy {
  onDataCallback: ((data: string) => void) | null;
  dataDisposeMock: Mock;
  termDisposeMock: Mock;
  disposeOrder: string[];
  loadAddonMock: Mock;
  openMock: Mock;
  writeMock: Mock;
}

const terminalSpies: TerminalSpy[] = [];

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    private spy: TerminalSpy;

    constructor(_opts: unknown) {
      const order: string[] = [];
      const spy: TerminalSpy = {
        onDataCallback: null,
        dataDisposeMock: vi.fn(() => {
          order.push("data");
        }),
        termDisposeMock: vi.fn(() => {
          order.push("term");
        }),
        disposeOrder: order,
        loadAddonMock: vi.fn(),
        openMock: vi.fn(),
        writeMock: vi.fn(),
      };
      this.spy = spy;
      terminalSpies.push(spy);
    }

    onData(cb: (data: string) => void) {
      this.spy.onDataCallback = cb;
      return { dispose: this.spy.dataDisposeMock };
    }

    loadAddon(addon: unknown) {
      this.spy.loadAddonMock(addon);
    }

    open(container: HTMLElement) {
      this.spy.openMock(container);
    }

    write(data: unknown) {
      this.spy.writeMock(data);
    }

    dispose() {
      this.spy.termDisposeMock();
    }
  }
  return { Terminal: FakeTerminal };
});

// FitAddon fake — we only need a `.fit()` spy and a no-op `activate`
// signature so `term.loadAddon(fit)` is harmless.
const fitMocks: Mock[] = [];

vi.mock("@xterm/addon-fit", () => {
  class FakeFitAddon {
    public fit: Mock;
    constructor() {
      this.fit = vi.fn();
      fitMocks.push(this.fit);
    }
    activate() {
      // no-op — Terminal.loadAddon would normally invoke this.
    }
    dispose() {
      // no-op
    }
  }
  return { FitAddon: FakeFitAddon };
});

// ResizeObserver fake. We capture the callback so the test can trigger
// it manually; `observe` / `disconnect` are also recorded for the
// disposal-order test.
type ROCallback = ResizeObserverCallback;
const resizeObservers: Array<{
  cb: ROCallback;
  observeMock: Mock;
  disconnectMock: Mock;
}> = [];

class FakeResizeObserver {
  public observeMock: Mock;
  public disconnectMock: Mock;
  constructor(cb: ROCallback) {
    this.observeMock = vi.fn();
    this.disconnectMock = vi.fn();
    resizeObservers.push({
      cb,
      observeMock: this.observeMock,
      disconnectMock: this.disconnectMock,
    });
  }
  observe(target: Element) {
    this.observeMock(target);
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    this.disconnectMock();
  }
}

// ---------- Harness ------------------------------------------------------

// Import after mocks are registered so the component picks them up.
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
  // Flush the microtask queue so `subscribeOutput().then(...)` runs.
  await act(async () => {
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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(async () => {
  await unmountAll();
  attachMock.mockClear();
  sendInputMock.mockClear();
  subscribeOutputMock.mockClear();
  terminalSpies.length = 0;
  fitMocks.length = 0;
  resizeObservers.length = 0;
  vi.unstubAllGlobals();
});

// ---------- Tests --------------------------------------------------------

describe("InteractiveTerminalMode keystroke + layout wiring", () => {
  it("forwards xterm `onData` to the G3 sendInput service", async () => {
    await render(<InteractiveTerminalMode sid="sid-key" />);

    expect(terminalSpies).toHaveLength(1);
    const spy = terminalSpies[0]!;
    expect(spy.onDataCallback).not.toBeNull();

    // Simulate a single keystroke flowing out of xterm.
    spy.onDataCallback!("x");

    // sendInput is fire-and-forget but invoked synchronously from the
    // onData callback, so it should be recorded before any awaits.
    expect(sendInputMock).toHaveBeenCalledWith("sid-key", "x");
    expect(sendInputMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs fit.fit() when ResizeObserver fires", async () => {
    await render(<InteractiveTerminalMode sid="sid-resize" />);

    expect(fitMocks).toHaveLength(1);
    expect(resizeObservers).toHaveLength(1);
    const fit = fitMocks[0]!;
    const ro = resizeObservers[0]!;

    // Component runs an initial fit() before installing the observer,
    // so account for that baseline.
    const baseline = fit.mock.calls.length;

    // Manually fire the ResizeObserver callback the way the browser
    // would on a container reshape. The component ignores the entry
    // payload, so an empty array is sufficient.
    act(() => {
      ro.cb([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
    });

    expect(fit.mock.calls.length).toBe(baseline + 1);
  });

  it("disposes the onData disposable before the terminal on unmount", async () => {
    await render(<InteractiveTerminalMode sid="sid-dispose" />);

    expect(terminalSpies).toHaveLength(1);
    const spy = terminalSpies[0]!;
    expect(resizeObservers).toHaveLength(1);
    const ro = resizeObservers[0]!;

    await unmountAll();

    // Both disposers fired exactly once.
    expect(spy.dataDisposeMock).toHaveBeenCalledTimes(1);
    expect(spy.termDisposeMock).toHaveBeenCalledTimes(1);

    // Order: ResizeObserver → onData disposable → terminal. The audit
    // calls out the data-before-terminal sequence explicitly; we also
    // pin disconnect-before-dispose so a future refactor that reorders
    // teardown trips this guard.
    expect(spy.disposeOrder).toEqual(["data", "term"]);
    const dataCallOrder = spy.dataDisposeMock.mock.invocationCallOrder[0]!;
    const termCallOrder = spy.termDisposeMock.mock.invocationCallOrder[0]!;
    const disconnectCallOrder =
      ro.disconnectMock.mock.invocationCallOrder[0]!;
    expect(disconnectCallOrder).toBeLessThan(dataCallOrder);
    expect(dataCallOrder).toBeLessThan(termCallOrder);
  });
});
