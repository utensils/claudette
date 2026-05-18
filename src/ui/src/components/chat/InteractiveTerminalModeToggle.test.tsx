// @vitest-environment happy-dom
//
// Coverage for the "Open in terminal" / "Back to chat" header toggle.
// The component is small but it owns three orthogonal gates — interactive
// harness, workspace id, session id — and a label/icon flip driven by
// the per-workspace `interactiveTerminalModeByWorkspace` map. Each branch
// needs an assertion to satisfy the patch-coverage gate.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InteractiveTerminalModeToggle } from "./InteractiveTerminalModeToggle";
import { useAppStore } from "../../stores/useAppStore";
import type { AgentBackendConfig } from "../../services/tauri/agentBackends";

function makeInteractiveBackend(
  overrides: Partial<AgentBackendConfig> = {},
): AgentBackendConfig {
  return {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    base_url: null,
    enabled: true,
    default_model: null,
    manual_models: [],
    discovered_models: [],
    auth_ref: null,
    capabilities: {
      thinking: false,
      effort: false,
      fast_mode: false,
      one_m_context: false,
      tools: true,
      vision: true,
    },
    context_window_default: 200000,
    model_discovery: false,
    has_secret: false,
    runtime_harness: "claude_interactive",
    ...overrides,
  };
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
  useAppStore.setState({
    agentBackends: [],
    defaultAgentBackendId: "anthropic",
    selectedModelProvider: {},
    selectedWorkspaceId: null,
    selectedSessionIdByWorkspaceId: {},
    claudeInteractiveEnabled: false,
    interactiveTerminalModeByWorkspace: {},
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

describe("InteractiveTerminalModeToggle", () => {
  it("renders nothing when the harness is not interactive", async () => {
    useAppStore.setState({
      agentBackends: [
        makeInteractiveBackend({ runtime_harness: undefined }),
      ],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: "ws-1",
      selectedSessionIdByWorkspaceId: { "ws-1": "sess-1" },
      claudeInteractiveEnabled: true,
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    expect(
      container.querySelector("[data-testid='interactive-terminal-mode-toggle']"),
    ).toBeNull();
  });

  it("renders nothing when there is no selected workspace", async () => {
    useAppStore.setState({
      agentBackends: [makeInteractiveBackend()],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: null,
      selectedSessionIdByWorkspaceId: {},
      claudeInteractiveEnabled: true,
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    expect(
      container.querySelector("[data-testid='interactive-terminal-mode-toggle']"),
    ).toBeNull();
  });

  it("renders nothing when there is no active session for the workspace", async () => {
    useAppStore.setState({
      agentBackends: [makeInteractiveBackend()],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: "ws-1",
      // No entry in selectedSessionIdByWorkspaceId → null active session.
      selectedSessionIdByWorkspaceId: {},
      claudeInteractiveEnabled: true,
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    expect(
      container.querySelector("[data-testid='interactive-terminal-mode-toggle']"),
    ).toBeNull();
  });

  it("renders the 'Open in terminal' affordance when interactive and chat mode", async () => {
    useAppStore.setState({
      agentBackends: [makeInteractiveBackend()],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: "ws-1",
      selectedSessionIdByWorkspaceId: { "ws-1": "sess-1" },
      claudeInteractiveEnabled: true,
      interactiveTerminalModeByWorkspace: {},
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='interactive-terminal-mode-toggle']",
    );
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    expect(btn?.getAttribute("aria-label")).toBe("Open in terminal");
  });

  it("renders the 'Back to chat' affordance when the terminal mode is active", async () => {
    useAppStore.setState({
      agentBackends: [makeInteractiveBackend()],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: "ws-1",
      selectedSessionIdByWorkspaceId: { "ws-1": "sess-1" },
      claudeInteractiveEnabled: true,
      interactiveTerminalModeByWorkspace: { "ws-1": true },
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='interactive-terminal-mode-toggle']",
    );
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-pressed")).toBe("true");
    expect(btn?.getAttribute("aria-label")).toBe("Back to chat");
  });

  it("flips the per-workspace terminalMode flag when clicked", async () => {
    useAppStore.setState({
      agentBackends: [makeInteractiveBackend()],
      selectedModelProvider: { "sess-1": "anthropic" },
      selectedWorkspaceId: "ws-1",
      selectedSessionIdByWorkspaceId: { "ws-1": "sess-1" },
      claudeInteractiveEnabled: true,
    });

    const container = await render(<InteractiveTerminalModeToggle />);
    const btn = container.querySelector<HTMLButtonElement>(
      "[data-testid='interactive-terminal-mode-toggle']",
    );
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.click();
    });
    expect(
      useAppStore.getState().interactiveTerminalModeByWorkspace["ws-1"],
    ).toBe(true);

    await act(async () => {
      btn!.click();
    });
    // Toggling off removes the key from the map (see uiSlice convention).
    expect(
      useAppStore.getState().interactiveTerminalModeByWorkspace["ws-1"],
    ).toBeUndefined();
  });
});
