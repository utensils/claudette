// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/useAppStore";
import { useWorkspaceElapsedSeconds } from "./useWorkspaceElapsedSeconds";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderProbe(
  workspaceId: string | null,
  isRunning: boolean,
): Promise<void> {
  function Probe() {
    const elapsed = useWorkspaceElapsedSeconds(workspaceId, isRunning);
    return <span data-testid="elapsed">{elapsed}</span>;
  }

  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }

  await act(async () => {
    root!.render(<Probe />);
  });
}

describe("useWorkspaceElapsedSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useAppStore.setState({ promptStartTime: {} });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("seeds a missing per-workspace timer anchor while running", async () => {
    await renderProbe("ws-1", true);

    expect(useAppStore.getState().promptStartTime["ws-1"]).toBe(
      1_700_000_000_000,
    );
    expect(container?.textContent).toBe("0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(container?.textContent).toBe("2");
  });

  it("uses each workspace's own timer anchor", async () => {
    useAppStore.getState().setPromptStartTime("ws-1", 1_699_999_990_000);
    useAppStore.getState().setPromptStartTime("ws-2", 1_699_999_970_000);

    await renderProbe("ws-1", true);
    expect(container?.textContent).toBe("10");

    await renderProbe("ws-2", true);
    expect(container?.textContent).toBe("30");
  });

  it("resets elapsed output when the workspace stops running", async () => {
    useAppStore.getState().setPromptStartTime("ws-1", 1_699_999_990_000);

    await renderProbe("ws-1", true);
    expect(container?.textContent).toBe("10");

    await renderProbe("ws-1", false);
    expect(container?.textContent).toBe("0");
  });
});
