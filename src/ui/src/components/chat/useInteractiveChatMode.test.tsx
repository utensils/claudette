// @vitest-environment happy-dom

// Tests for the ChatPanel router hook. The hook is small but it
// guards the whole interactive-vs-classic render fork, so the matrix
// it returns has to be pinned by tests:
//   - When no backend matches the session's provider → fall back to
//     `claude_code` (the safe classic default). This is the
//     regression guard for ChatPanel — a mid-hydration store must not
//     trigger the new render path.
//   - When the matching backend's effective harness is
//     `claude_interactive`, `isInteractive` flips to true.
//   - `terminalMode` only ever surfaces true when the workspace flag
//     is set AND the harness is interactive.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useInteractiveChatMode } from "./useInteractiveChatMode";
import type { InteractiveChatMode } from "./useInteractiveChatMode";
import { useAppStore } from "../../stores/useAppStore";
import type { AgentBackendConfig } from "../../services/tauri/agentBackends";

function makeBackend(
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
    runtime_harness: undefined,
    ...overrides,
  };
}

// Mirror the manual-mount renderHook pattern used in
// `useInteractiveTurnAssembler.test.ts` — happy-dom/jsdom have no
// `@testing-library/react` in this codebase, so we capture the latest
// hook value via a probe component.
const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function captureMode(
  workspaceId: string | null,
  sessionId: string | null,
): Promise<InteractiveChatMode> {
  let captured: InteractiveChatMode | null = null;
  function Probe() {
    captured = useInteractiveChatMode(workspaceId, sessionId);
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
  if (captured === null) {
    throw new Error("Probe never rendered useInteractiveChatMode");
  }
  return captured;
}

beforeEach(() => {
  useAppStore.setState({
    agentBackends: [],
    defaultAgentBackendId: "anthropic",
    selectedModelProvider: {},
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

describe("useInteractiveChatMode", () => {
  it("defaults to claude_code when the backend is missing", async () => {
    const mode = await captureMode("ws-1", "sess-1");
    expect(mode.harness).toBe("claude_code");
    expect(mode.isInteractive).toBe(false);
    expect(mode.terminalMode).toBe(false);
  });

  it("returns claude_code for an Anthropic backend without harness override", async () => {
    useAppStore.setState({
      agentBackends: [makeBackend({ id: "anthropic", kind: "anthropic" })],
      selectedModelProvider: { "sess-1": "anthropic" },
    });
    const mode = await captureMode("ws-1", "sess-1");
    expect(mode.isInteractive).toBe(false);
  });

  it("flips isInteractive when the override + experimental flag agree", async () => {
    useAppStore.setState({
      agentBackends: [
        makeBackend({
          id: "anthropic",
          kind: "anthropic",
          runtime_harness: "claude_interactive",
        }),
      ],
      selectedModelProvider: { "sess-1": "anthropic" },
      claudeInteractiveEnabled: true,
    });
    const mode = await captureMode("ws-1", "sess-1");
    expect(mode.harness).toBe("claude_interactive");
    expect(mode.isInteractive).toBe(true);
    expect(mode.terminalMode).toBe(false);
  });

  it("ignores claude_interactive override when the experimental flag is off", async () => {
    useAppStore.setState({
      agentBackends: [
        makeBackend({
          id: "anthropic",
          kind: "anthropic",
          runtime_harness: "claude_interactive",
        }),
      ],
      selectedModelProvider: { "sess-1": "anthropic" },
      claudeInteractiveEnabled: false,
    });
    const mode = await captureMode("ws-1", "sess-1");
    expect(mode.isInteractive).toBe(false);
  });

  it("surfaces terminalMode only when the per-workspace flag is set AND interactive", async () => {
    useAppStore.setState({
      agentBackends: [
        makeBackend({
          id: "anthropic",
          kind: "anthropic",
          runtime_harness: "claude_interactive",
        }),
      ],
      selectedModelProvider: { "sess-1": "anthropic" },
      claudeInteractiveEnabled: true,
      interactiveTerminalModeByWorkspace: { "ws-1": true },
    });
    const mode = await captureMode("ws-1", "sess-1");
    expect(mode.terminalMode).toBe(true);
  });

  it("never returns terminalMode=true on the classic render path", async () => {
    useAppStore.setState({
      agentBackends: [makeBackend({ id: "anthropic", kind: "anthropic" })],
      selectedModelProvider: { "sess-1": "anthropic" },
      interactiveTerminalModeByWorkspace: { "ws-1": true },
    });
    const mode = await captureMode("ws-1", "sess-1");
    // Workspace flag is set, but harness is claude_code → terminalMode
    // must stay false so a leftover flag doesn't sabotage a classic
    // workspace.
    expect(mode.terminalMode).toBe(false);
  });

  it("falls back to the default backend when no session-scoped provider is set", async () => {
    useAppStore.setState({
      agentBackends: [
        makeBackend({
          id: "anthropic",
          kind: "anthropic",
          runtime_harness: "claude_interactive",
        }),
      ],
      defaultAgentBackendId: "anthropic",
      selectedModelProvider: {},
      claudeInteractiveEnabled: true,
    });
    const mode = await captureMode("ws-1", null);
    expect(mode.harness).toBe("claude_interactive");
  });

  it("toggleInteractiveTerminalMode flips the per-workspace flag", () => {
    const before = useAppStore.getState().interactiveTerminalModeByWorkspace;
    expect(before["ws-1"]).toBeUndefined();
    useAppStore.getState().toggleInteractiveTerminalMode("ws-1");
    expect(
      useAppStore.getState().interactiveTerminalModeByWorkspace["ws-1"],
    ).toBe(true);
    useAppStore.getState().toggleInteractiveTerminalMode("ws-1");
    expect(
      useAppStore.getState().interactiveTerminalModeByWorkspace["ws-1"],
    ).toBeUndefined();
  });
});
