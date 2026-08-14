// @vitest-environment happy-dom

// Regression suite for `usePendingChatPrompt` — the consumer side of the
// pinned-prompt handoff queue. `ChatPanelSessionView` hosts this hook and
// stays mounted across session switches, so the hook's guards have to be
// correct per session rather than per hook instance.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "../../stores/useAppStore";
import { usePendingChatPrompt } from "./usePendingChatPrompt";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

/** A promise whose resolution the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface HarnessProps {
  sessionId: string | null;
  send: (content: string) => void | Promise<void>;
}

function Harness({ sessionId, send }: HarnessProps) {
  usePendingChatPrompt(sessionId, send);
  return null;
}

/**
 * Mounts the hook and returns a `setSession` that re-renders the *same*
 * root with a new active session — mirroring how `ChatPanelSessionView`
 * receives a new `activeSessionId` on a tab switch without remounting, so
 * the hook's refs survive exactly as they do in the app.
 */
async function mountHarness(props: HarnessProps): Promise<{
  setSession: (id: string | null) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  return {
    setSession: async (id) => {
      await act(async () => {
        root.render(<Harness {...props} sessionId={id} />);
      });
    },
  };
}

beforeEach(() => {
  useAppStore.setState({ pendingChatPrompts: [] });
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

describe("usePendingChatPrompt", () => {
  it("dispatches a prompt queued for the active session", async () => {
    const sent: string[] = [];
    await mountHarness({
      sessionId: "sess-a",
      send: (content) => {
        sent.push(content);
      },
    });

    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-a", "/review");
    });

    expect(sent).toEqual(["/review"]);
    expect(useAppStore.getState().pendingChatPrompts).toEqual([]);
  });

  it("leaves another session's prompt queued", async () => {
    const sent: string[] = [];
    await mountHarness({
      sessionId: "sess-a",
      send: (content) => {
        sent.push(content);
      },
    });

    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-b", "/review");
    });

    expect(sent).toEqual([]);
    expect(useAppStore.getState().pendingChatPrompts).toHaveLength(1);
  });

  it("drains a second session while the first is still in flight", async () => {
    // The bug this pins: a single hook-wide `draining` flag let session A's
    // in-flight dispatch block the effect run that should have started
    // draining session B. A's `finally` only wrote a ref — no render, so no
    // retry — and B's prompt sat queued forever. Clicking a second new-tab
    // pin while the first turn was still dispatching hit exactly this.
    const sent: string[] = [];
    const gate = deferred();
    const harness = await mountHarness({
      sessionId: "sess-a",
      send: (content) => {
        sent.push(content);
        return content === "for-a" ? gate.promise : undefined;
      },
    });

    // A starts draining and parks on the gate.
    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-a", "for-a");
    });
    expect(sent).toEqual(["for-a"]);

    // A second pin opens session B and queues against it while A is stuck.
    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-b", "for-b");
    });
    await harness.setSession("sess-b");

    expect(sent).toEqual(["for-a", "for-b"]);
    expect(useAppStore.getState().pendingChatPrompts).toEqual([]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it("keeps draining a session's queue after the user navigates away", async () => {
    // The drain closes over the session it started on, so a backlog for the
    // session the user just left still completes rather than stalling.
    const sent: string[] = [];
    const gate = deferred();
    const harness = await mountHarness({
      sessionId: "sess-a",
      send: (content) => {
        sent.push(content);
        return content === "first" ? gate.promise : undefined;
      },
    });

    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-a", "first");
    });
    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-a", "second");
    });
    await harness.setSession("sess-b");

    expect(sent).toEqual(["first"]);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    expect(sent).toEqual(["first", "second"]);
    expect(useAppStore.getState().pendingChatPrompts).toEqual([]);
  });

  it("does not re-dispatch a prompt when send rejects", async () => {
    const sent: string[] = [];
    await mountHarness({
      sessionId: "sess-a",
      send: (content) => {
        sent.push(content);
        return Promise.reject(new Error("boom"));
      },
    });

    await act(async () => {
      useAppStore.getState().enqueueChatPrompt("sess-a", "/review");
    });

    expect(sent).toEqual(["/review"]);
    expect(useAppStore.getState().pendingChatPrompts).toEqual([]);
  });
});
