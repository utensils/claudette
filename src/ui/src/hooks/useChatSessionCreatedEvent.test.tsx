// @vitest-environment happy-dom

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
      const after = registeredHandlers.get(eventName)?.filter((h) => h !== handler) ?? [];
      registeredHandlers.set(eventName, after);
    });
  },
}));

import { useChatSessionCreatedEvent } from "./useChatSessionCreatedEvent";
import { useAppStore } from "../stores/useAppStore";
import type { ChatSession } from "../types";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountHook(): Promise<void> {
  function Probe() {
    useChatSessionCreatedEvent();
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

function makeSession(id: string): ChatSession {
  return {
    id,
    workspace_id: "ws-1",
    session_id: null,
    name: "Team / worker",
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
  };
}

beforeEach(() => {
  registeredHandlers.clear();
  useAppStore.setState({
    sessionsByWorkspace: {},
    sessionsLoadedByWorkspace: {},
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

describe("useChatSessionCreatedEvent", () => {
  it("registers a Tauri listener for chat-session-created", async () => {
    await mountHook();
    expect(registeredHandlers.get("chat-session-created")?.length).toBeGreaterThan(0);
  });

  it("adds the created session to the store", async () => {
    await mountHook();
    const handlers = registeredHandlers.get("chat-session-created") ?? [];
    const session = makeSession("session-1");

    await act(async () => {
      for (const handler of handlers) {
        handler({ payload: session });
      }
    });

    expect(useAppStore.getState().sessionsByWorkspace["ws-1"]).toEqual([session]);
    expect(useAppStore.getState().sessionsLoadedByWorkspace["ws-1"]).toBe(true);
  });
});
