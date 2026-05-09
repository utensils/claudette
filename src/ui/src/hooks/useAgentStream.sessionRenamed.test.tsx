// @vitest-environment happy-dom

/**
 * Regression test for the chat-tab auto-rename live update.
 *
 * The Rust side emits a `session-renamed` Tauri event from
 * `try_generate_session_name` after Haiku produces a short label
 * for the first user prompt. The frontend listener for that event
 * was missing — meaning the chat tab kept its placeholder name
 * until the user switched workspaces and came back (which forced
 * `SessionTabs` to re-fetch the session list). The fix is a one-
 * useEffect listener; this test pins it.
 *
 * Strategy: mock `@tauri-apps/api/event`'s `listen()` so we can
 * capture every registered event handler by name, then mount
 * `useAgentStream` in a probe component, retrieve the
 * `session-renamed` handler, fire it with a payload, and assert
 * the chat-session slice was updated.
 *
 * If a future refactor drops the listener (regression), this test
 * fails at the `expect(handler).toBeDefined()` assertion before any
 * payload is even fired.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every Tauri event listener registered by the hook so the
// test can synthesize an event without round-tripping through real
// Tauri. The map is reset per-test in `beforeEach`.
type HandlerRecord = (event: { payload: unknown }) => void;
const registeredHandlers = new Map<string, HandlerRecord[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: HandlerRecord) => {
    const list = registeredHandlers.get(eventName) ?? [];
    list.push(handler);
    registeredHandlers.set(eventName, list);
    return Promise.resolve(() => {
      const after = registeredHandlers.get(eventName)?.filter((h) => h !== handler) ?? [];
      registeredHandlers.set(eventName, after);
    });
  },
}));

// Stub out the heavy backend calls `useAgentStream` makes from inside
// other listeners — they're not exercised by this test but the hook
// imports them at module load so the mocks must exist.
vi.mock("../services/tauri", async () => {
  const actual = await vi.importActual<typeof import("../services/tauri")>(
    "../services/tauri",
  );
  return {
    ...actual,
    loadChatHistory: vi.fn().mockResolvedValue([]),
    saveTurnToolActivities: vi.fn().mockResolvedValue(undefined),
    setSessionCliInvocation: vi.fn().mockResolvedValue(undefined),
  };
});

// Imports must come AFTER the vi.mock() calls so the mocks are wired
// before the module-under-test resolves them.
import { useAgentStream } from "./useAgentStream";
import { useAppStore } from "../stores/useAppStore";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountHook(): Promise<void> {
  function Probe() {
    useAgentStream();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Probe />);
  });
}

beforeEach(() => {
  registeredHandlers.clear();
  // Seed a known chat session so the slice update has something to
  // mutate. The test only cares about `name` flipping; other fields
  // are placeholder values matching the `ChatSession` shape.
  useAppStore.setState({
    sessionsByWorkspace: {
      "ws-1": [
        {
          id: "session-1",
          workspace_id: "ws-1",
          session_id: null,
          name: "New chat",
          name_edited: false,
          turn_count: 0,
          sort_order: 0,
          status: "Active",
          created_at: new Date().toISOString(),
          archived_at: null,
          cli_invocation: null,
          agent_status: "Stopped",
          needs_attention: false,
          attention_kind: null,
        },
      ],
    },
  });
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

describe("useAgentStream — session-renamed listener", () => {
  it("registers a Tauri listener for the session-renamed event", async () => {
    await mountHook();
    expect(registeredHandlers.get("session-renamed")?.length).toBeGreaterThan(0);
  });

  it("updates the matching chat session's name when the event fires", async () => {
    await mountHook();
    const handlers = registeredHandlers.get("session-renamed") ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    await act(async () => {
      for (const handler of handlers) {
        handler({
          payload: { session_id: "session-1", name: "Initial prompt summary" },
        });
      }
    });

    const sessions =
      useAppStore.getState().sessionsByWorkspace["ws-1"] ?? [];
    const updated = sessions.find((s) => s.id === "session-1");
    expect(updated?.name).toBe("Initial prompt summary");
  });

  it("ignores rename payloads for unknown sessions", async () => {
    await mountHook();
    const handlers = registeredHandlers.get("session-renamed") ?? [];

    await act(async () => {
      for (const handler of handlers) {
        handler({
          payload: { session_id: "ghost-session", name: "should not surface" },
        });
      }
    });

    const sessions =
      useAppStore.getState().sessionsByWorkspace["ws-1"] ?? [];
    // The known session keeps its original name; the unknown id is a
    // no-op (matches `updateChatSession`'s contract — it walks every
    // workspace's session list and updates only when it finds an id
    // match).
    expect(sessions.find((s) => s.id === "session-1")?.name).toBe("New chat");
  });
});
