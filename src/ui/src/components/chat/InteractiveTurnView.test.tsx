// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

import { InteractiveTurnView } from "./InteractiveTurnView";

// xterm.js paints asynchronously into the DOM, so the test polls until
// the expected text appears (or a short timeout elapses). Mirrors the
// `waitFor` helper from @testing-library/react without pulling in that
// dependency.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 16 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error("waitFor predicate never satisfied");
  }
}

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
});

describe("InteractiveTurnView", () => {
  it("writes incoming bytes into xterm.js", async () => {
    const container = await render(
      <InteractiveTurnView bytes={new TextEncoder().encode("hello\r\n")} />,
    );

    await waitFor(() => (container.textContent ?? "").includes("hello"));
    expect(container.textContent ?? "").toContain("hello");
  });

  it("creates the xterm host element", async () => {
    const container = await render(
      <InteractiveTurnView bytes={new TextEncoder().encode("")} />,
    );

    // The xterm.js renderer drops a `.xterm` element into the host the
    // moment `term.open()` runs. Use it as a synchronous-mount sentinel
    // so we know `useEffect` did its work before unmount.
    await waitFor(() => container.querySelector(".xterm") !== null);
    expect(container.querySelector(".xterm")).not.toBeNull();
  });

  it("disposes the terminal on unmount", async () => {
    // Spy on xterm's prototype `dispose` so we can verify the cleanup
    // path actually invoked it. The previous version of this test only
    // asserted `true === true`, which made it impossible for a
    // regression in the unmount effect to fail the suite.
    const disposeSpy = vi.spyOn(Terminal.prototype, "dispose");
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <InteractiveTurnView bytes={new TextEncoder().encode("hello")} />,
        );
      });
      const callsBeforeUnmount = disposeSpy.mock.calls.length;
      await act(async () => {
        root.unmount();
      });
      container.remove();
      expect(disposeSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it("retains the rendered bytes when rows/cols change", async () => {
    // Regression: the mount effect re-creates the xterm instance when
    // rows/cols change, so we must replay the accumulated `bytes` into
    // the fresh terminal — otherwise the new terminal renders empty
    // until the parent next mutates `bytes`.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    const payload = new TextEncoder().encode("preserved-on-resize\r\n");

    await act(async () => {
      root.render(
        <InteractiveTurnView bytes={payload} rows={24} cols={80} />,
      );
    });
    await waitFor(() =>
      (container.textContent ?? "").includes("preserved-on-resize"),
    );

    // Change rows/cols WITHOUT changing bytes. The same `payload`
    // reference is passed so the bytes effect's dependency doesn't
    // change — the only thing forcing work is the rows/cols remount.
    await act(async () => {
      root.render(
        <InteractiveTurnView bytes={payload} rows={30} cols={120} />,
      );
    });

    await waitFor(() =>
      (container.textContent ?? "").includes("preserved-on-resize"),
    );
    expect(container.textContent ?? "").toContain("preserved-on-resize");
  });

  it("appends new bytes when the prop reference changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);

    await act(async () => {
      root.render(
        <InteractiveTurnView bytes={new TextEncoder().encode("first ")} />,
      );
    });
    await waitFor(() => (container.textContent ?? "").includes("first"));

    await act(async () => {
      root.render(
        <InteractiveTurnView
          bytes={new TextEncoder().encode("first second")}
        />,
      );
    });
    await waitFor(() => (container.textContent ?? "").includes("second"));
    expect(container.textContent ?? "").toContain("second");
  });
});
