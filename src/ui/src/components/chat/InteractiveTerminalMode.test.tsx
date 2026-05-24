// @vitest-environment happy-dom

// Smoke test for the full-terminal interactive view. We mock the G3
// service surface so the component can mount / unmount without any
// actual Tauri runtime, and confirm:
//   - The xterm host element appears (xterm.js's `.xterm` sentinel).
//   - `attach` is invoked for the supplied sid.
//   - `subscribeOutput` is invoked for the supplied sid and the
//     resolved unlisten function is called on unmount (no leak).

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InteractiveTerminalMode } from "./InteractiveTerminalMode";

const attachMock = vi.fn(async (_sid: string) => undefined);
const sendInputMock = vi.fn(async (_sid: string, _text: string) => undefined);
const subscribeOutputUnlistens: Array<() => void> = [];
const subscribeOutputMock = vi.fn(
  async (_sid: string, _fn: (ev: unknown) => void) => {
    const unlisten = vi.fn();
    subscribeOutputUnlistens.push(unlisten);
    return unlisten;
  },
);

vi.mock("../../services/interactive", () => ({
  attach: (sid: string) => attachMock(sid),
  sendInput: (sid: string, text: string) => sendInputMock(sid, text),
  subscribeOutput: (sid: string, fn: (ev: unknown) => void) =>
    subscribeOutputMock(sid, fn),
}));

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
  // Let microtasks flush — the component awaits subscribeOutput inside
  // a `.then()` chain so the unlisten registration runs one microtask
  // after the synchronous render returns.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
  attachMock.mockClear();
  sendInputMock.mockClear();
  subscribeOutputMock.mockClear();
  subscribeOutputUnlistens.length = 0;
});

describe("InteractiveTerminalMode", () => {
  it("mounts xterm.js and wires the G3 services", async () => {
    const container = await render(<InteractiveTerminalMode sid="sid-42" />);

    // xterm.js writes its DOM into a `.xterm` element on `term.open()`.
    expect(container.querySelector(".xterm")).not.toBeNull();
    expect(attachMock).toHaveBeenCalledWith("sid-42");
    expect(subscribeOutputMock).toHaveBeenCalledWith(
      "sid-42",
      expect.any(Function),
    );
  });

  it("releases the output subscription on unmount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InteractiveTerminalMode sid="sid-77" />);
    });
    // Allow the subscribeOutput promise to settle and the unlisten to be
    // captured by the effect.
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribeOutputUnlistens).toHaveLength(1);
    const unlisten = subscribeOutputUnlistens[0]!;
    expect(unlisten).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not crash when unmounted immediately", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<InteractiveTerminalMode sid="sid-99" />);
    });
    // Unmount before subscribeOutput resolves to exercise the
    // `cancelled` branch in the effect.
    await act(async () => {
      root.unmount();
    });
    container.remove();
    // No assertion needed — vitest treats no-throw as pass.
  });
});
