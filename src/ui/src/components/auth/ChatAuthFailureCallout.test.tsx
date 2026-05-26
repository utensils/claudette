// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import { ChatAuthFailureCallout } from "./ChatAuthFailureCallout";

const serviceMocks = vi.hoisted(() => ({
  getClaudeAuthStatus: vi.fn(() =>
    Promise.resolve({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    }),
  ),
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
  submitClaudeAuthCode: vi.fn(() => Promise.resolve()),
  launchCodexLogin: vi.fn(() => Promise.resolve()),
}));

const eventMocks = vi.hoisted(() => {
  const listeners = new Map<
    string,
    Array<(event: { payload: unknown }) => void>
  >();
  return {
    listeners,
    listen: vi.fn(
      (event: string, handler: (event: { payload: unknown }) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return Promise.resolve(() => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((entry) => entry !== handler),
          );
        });
      },
    ),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("../../services/tauri", () => serviceMocks);

const CODEX_AUTH_ERROR =
  "Codex authentication expired. Run /login (or `codex login` in a terminal), then send the message again.";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCallout() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ChatAuthFailureCallout
        error={CODEX_AUTH_ERROR}
        messageId="assistant-1"
      />,
    );
  });
  return container;
}

beforeEach(() => {
  serviceMocks.launchCodexLogin.mockClear();
  serviceMocks.launchCodexLogin.mockResolvedValue(undefined);
  eventMocks.listen.mockClear();
  eventMocks.listeners.clear();
  useAppStore.setState({
    claudeAuthFailure: {
      messageId: "assistant-1",
      error: CODEX_AUTH_ERROR,
    },
    resolvedClaudeAuthFailureMessageId: null,
    selectedWorkspaceId: "workspace-1",
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("ChatAuthFailureCallout", () => {
  it("marks Codex auth failures recovered when Codex login completes", async () => {
    const element = await renderCallout();
    const button = Array.from(element.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("auth_sign_in"),
    );

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(serviceMocks.launchCodexLogin).toHaveBeenCalledWith("workspace-1");

    await act(async () => {
      eventMocks.listeners.get("codex://login-complete")?.forEach((handler) => {
        handler({ payload: { success: true, error: null } });
      });
      await Promise.resolve();
    });

    expect(useAppStore.getState().claudeAuthFailure).toBeNull();
    expect(useAppStore.getState().resolvedClaudeAuthFailureMessageId).toBe(
      "assistant-1",
    );
  });
});
