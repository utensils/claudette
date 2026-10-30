// @vitest-environment happy-dom

/**
 * Stream deltas are frame-coalesced (`StreamDeltaBuffer`). These tests pin
 * the ordering contract: deltas are not written per chunk, but every
 * non-delta event observes the fully-applied state.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HandlerRecord = (event: { payload: unknown }) => void;
const registeredHandlers = new Map<string, HandlerRecord[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: HandlerRecord) => {
    const list = registeredHandlers.get(eventName) ?? [];
    list.push(handler);
    registeredHandlers.set(eventName, list);
    return Promise.resolve(() => {
      const after =
        registeredHandlers.get(eventName)?.filter((h) => h !== handler) ?? [];
      registeredHandlers.set(eventName, after);
    });
  },
}));

const persistAgentSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/tauri", async () => {
  const actual = await vi.importActual<typeof import("../services/tauri")>(
    "../services/tauri",
  );
  return {
    ...actual,
    loadChatHistory: vi.fn().mockResolvedValue([]),
    saveTurnToolActivities: vi.fn().mockResolvedValue(undefined),
    setSessionCliInvocation: vi.fn().mockResolvedValue(undefined),
    updateTurnToolActivityProgress: vi.fn().mockResolvedValue(undefined),
    updateTurnAgentActivity: persistAgentSpy,
  };
});

import { useAgentStream } from "./useAgentStream";
import { useAppStore } from "../stores/useAppStore";

const WS_ID = "ws-1";
const SESSION_ID = "session-1";

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

async function stream(event: unknown): Promise<void> {
  const handlers = registeredHandlers.get("agent-stream") ?? [];
  await act(async () => {
    for (const handler of handlers) {
      handler({
        payload: {
          workspace_id: WS_ID,
          chat_session_id: SESSION_ID,
          event: { Stream: { type: "stream_event", event } },
        },
      });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  registeredHandlers.clear();
  useAppStore.setState({
    toolActivities: {},
    completedTurns: {},
    streamingContent: {},
    streamingThinking: {},
    promptStartTime: {},
    sessionsByWorkspace: {},
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) container.remove();
});

describe("useAgentStream — delta coalescing", () => {
  it("applies buffered text deltas on the next frame", async () => {
    await mountHook();
    await stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } });
    await stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
    expect(useAppStore.getState().streamingContent[SESSION_ID] ?? "").toBe("");
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(useAppStore.getState().streamingContent[SESSION_ID]).toBe("Hello");
  });

  it("content_block_stop sees the complete tool input", async () => {
    await mountHook();
    await stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu1", name: "Read", input: {} },
    });
    await stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path":' },
    });
    await stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"/repo/a.ts"}' },
    });
    // No timer advance: the stop event itself must flush.
    await stream({ type: "content_block_stop", index: 1 });
    const activity = useAppStore.getState().toolActivities[SESSION_ID]?.[0];
    expect(activity?.inputJson).toContain('"/repo/a.ts"}');
    expect(activity?.summary).toContain("a.ts");
  });
});
