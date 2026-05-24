// @vitest-environment happy-dom

// Test that `InteractiveTurns` renders one `InteractiveTurnView` per
// turn from the assembler hook and surfaces the awaiting / crashed
// aux indicators conditionally. The assembler hook is mocked so we
// don't have to wire up the G3 Tauri subscriptions in jsdom.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InteractiveTurns } from "./InteractiveTurns";
import type { UseInteractiveTurnAssembler } from "../../hooks/useInteractiveTurnAssembler";

// Mock the assembler hook so we drive the rendered output directly.
const mockReturnRef = { current: emptyState() };
vi.mock("../../hooks/useInteractiveTurnAssembler", () => ({
  useInteractiveTurnAssembler: () => mockReturnRef.current,
}));

// Stub the InteractiveTurnView so the test asserts on a stable DOM
// surface (a `<pre data-testid="iturnview">`) rather than depending on
// xterm.js's async renderer landing bytes inside happy-dom.
vi.mock("./InteractiveTurnView", () => ({
  InteractiveTurnView: ({ bytes }: { bytes: Uint8Array }) => (
    <pre data-testid="iturnview">{new TextDecoder().decode(bytes)}</pre>
  ),
}));

function emptyState(): UseInteractiveTurnAssembler {
  return { turns: [], awaitingInput: false, crashed: false };
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

beforeEach(() => {
  mockReturnRef.current = emptyState();
});

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

describe("InteractiveTurns", () => {
  it("renders one InteractiveTurnView per turn", async () => {
    mockReturnRef.current = {
      turns: [
        {
          id: 0,
          bytes: new TextEncoder().encode("first"),
          status: "done",
        },
        {
          id: 1,
          bytes: new TextEncoder().encode("second"),
          status: "live",
        },
      ],
      awaitingInput: false,
      crashed: false,
    };

    const container = await render(<InteractiveTurns sid="sid-1" />);
    const views = container.querySelectorAll('[data-testid="iturnview"]');
    expect(views).toHaveLength(2);
    expect(views[0]?.textContent).toBe("first");
    expect(views[1]?.textContent).toBe("second");
  });

  it("renders the awaiting pill when awaitingInput is true", async () => {
    mockReturnRef.current = {
      turns: [
        { id: 0, bytes: new Uint8Array(0), status: "live" },
      ],
      awaitingInput: true,
      crashed: false,
    };

    const container = await render(<InteractiveTurns sid="sid-1" />);
    expect(
      container.querySelector('[data-testid="interactive-awaiting-pill"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="interactive-crashed-banner"]'),
    ).toBeNull();
  });

  it("omits the awaiting pill when awaitingInput is false", async () => {
    mockReturnRef.current = {
      turns: [
        { id: 0, bytes: new Uint8Array(0), status: "live" },
      ],
      awaitingInput: false,
      crashed: false,
    };

    const container = await render(<InteractiveTurns sid="sid-1" />);
    expect(
      container.querySelector('[data-testid="interactive-awaiting-pill"]'),
    ).toBeNull();
  });

  it("renders the crashed banner when crashed is true", async () => {
    mockReturnRef.current = {
      turns: [
        { id: 0, bytes: new Uint8Array(0), status: "crashed" },
      ],
      awaitingInput: false,
      crashed: true,
    };

    const container = await render(<InteractiveTurns sid="sid-1" />);
    expect(
      container.querySelector('[data-testid="interactive-crashed-banner"]'),
    ).not.toBeNull();
  });

  it("renders nothing-but-container when there are no turns and no aux state", async () => {
    const container = await render(<InteractiveTurns sid="sid-1" />);
    const root = container.querySelector('[data-testid="interactive-turns"]');
    expect(root).not.toBeNull();
    expect(root?.children).toHaveLength(0);
  });
});
