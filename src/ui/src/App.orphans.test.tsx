// @vitest-environment happy-dom

// Coverage for the App-level orphan-detected listener wiring.
//
// `App.tsx` is a god file (1000+ lines, dozens of providers / store
// reads / Tauri listeners). Mounting `<App />` directly would require
// stubbing every one of those collaborators — most of which have
// nothing to do with the orphan path. To keep this test focused (and
// surgical to the F3 audit gap), the orphan listener-effect lives in a
// sibling component `OrphanListener.tsx`. `<App />` mounts it
// unconditionally; mounting `<OrphanListener />` in isolation here
// exercises the exact same effect with none of the noise.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need the captured listener callback so the test can fire a fake
// orphan-detected event, plus a spy on `cleanupOrphans` so we can
// assert the auto-cleanup invocation. Mock the whole interactive
// service module before importing the component-under-test.
let capturedHandler: ((ev: { sids: string[] }) => void) | null = null;
let unlistenSpy: ReturnType<typeof vi.fn> | null = null;
const cleanupOrphansSpy = vi.fn();

vi.mock("./services/interactive", () => ({
  subscribeOrphansDetected: (fn: (ev: { sids: string[] }) => void) => {
    capturedHandler = fn;
    unlistenSpy = vi.fn();
    return Promise.resolve(unlistenSpy);
  },
  cleanupOrphans: (): Promise<string[]> => cleanupOrphansSpy(),
}));

import { OrphanListener } from "./OrphanListener";
import { useAppStore } from "./stores/useAppStore";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountListener(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<OrphanListener />);
  });
  // The subscribe call is async — flush microtasks so the listener
  // promise resolves and `capturedHandler` is populated before the
  // test fires a fake event.
  await act(async () => {
    await Promise.resolve();
  });
  return root;
}

beforeEach(() => {
  capturedHandler = null;
  unlistenSpy = null;
  cleanupOrphansSpy.mockReset();
  cleanupOrphansSpy.mockResolvedValue([] as string[]);
  useAppStore.setState({ toasts: [] });
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

describe("OrphanListener (App-level orphan-detected wiring)", () => {
  it("shows a toast when an orphan-detected event fires", async () => {
    await mountListener();
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      capturedHandler?.({ sids: ["claudette-sess-a", "claudette-sess-b"] });
    });

    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toMatch(/2 orphan interactive sessions/);
  });

  it("auto-invokes cleanupOrphans after the toast", async () => {
    await mountListener();
    expect(capturedHandler).not.toBeNull();

    expect(cleanupOrphansSpy).not.toHaveBeenCalled();
    await act(async () => {
      capturedHandler?.({ sids: ["claudette-sess-a"] });
    });

    // The cleanup invocation is synchronous from the handler's
    // perspective (Promise spawned, no await in the listener), so it
    // should already be queued by the time we assert.
    expect(cleanupOrphansSpy).toHaveBeenCalledTimes(1);
    // Flush the cleanup promise so the `.then` runs without a Vitest
    // unhandled-rejection complaint.
    await act(async () => {
      await Promise.resolve();
    });

    // Toast wording uses the singular form for sids.length === 1 —
    // pin it so a future copy edit doesn't silently regress the
    // pluralization branch.
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toMatch(/1 orphan interactive session\b/);
    expect(toasts[0]?.message).not.toMatch(/sessions/);
  });

  it("calls the unlisten function on unmount", async () => {
    const root = await mountListener();
    expect(unlistenSpy).not.toBeNull();
    expect(unlistenSpy).not.toHaveBeenCalled();

    // Drop the mounted root from the cleanup list so afterEach doesn't
    // try to unmount a second time.
    const idx = mountedRoots.indexOf(root);
    if (idx >= 0) mountedRoots.splice(idx, 1);

    await act(async () => {
      root.unmount();
    });

    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores orphan-detected events with an empty sids list", async () => {
    await mountListener();
    expect(capturedHandler).not.toBeNull();

    await act(async () => {
      capturedHandler?.({ sids: [] });
    });

    expect(useAppStore.getState().toasts).toHaveLength(0);
    expect(cleanupOrphansSpy).not.toHaveBeenCalled();
  });
});
