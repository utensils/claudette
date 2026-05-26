import { describe, expect, it } from "vitest";

import type {
  AgentBackendConfig,
  AgentBackendKind,
} from "../../services/tauri/agentBackends";
import { resolveSessionBackend } from "./resolveSessionBackend";

function backend(kind: AgentBackendKind, id: string = kind): AgentBackendConfig {
  return {
    id,
    label: id,
    kind,
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
      vision: false,
    },
    context_window_default: 0,
    model_discovery: false,
    has_secret: false,
    runtime_harness: null,
  };
}

describe("resolveSessionBackend", () => {
  it("prefers the explicit per-session provider", () => {
    const anthropic = backend("anthropic", "anthropic");
    const codex = backend("codex_native", "codex");

    expect(
      resolveSessionBackend({
        sessionId: "s1",
        selectedModelProvider: { s1: "codex" },
        agentBackends: [anthropic, codex],
        defaultAgentBackendId: "anthropic",
      }),
    ).toBe(codex);
  });

  it("falls back to the configured default backend", () => {
    const anthropic = backend("anthropic", "anthropic");
    const openrouter = backend("custom_openai", "openrouter");

    expect(
      resolveSessionBackend({
        sessionId: "s1",
        selectedModelProvider: {},
        agentBackends: [anthropic, openrouter],
        defaultAgentBackendId: "openrouter",
      }),
    ).toBe(openrouter);
  });

  it("falls back to the first loaded backend when the configured default is absent", () => {
    const codex = backend("codex_native", "codex");

    expect(
      resolveSessionBackend({
        sessionId: "s1",
        selectedModelProvider: {},
        agentBackends: [codex],
        defaultAgentBackendId: "anthropic",
      }),
    ).toBe(codex);
  });

  it("returns null before backends load", () => {
    expect(
      resolveSessionBackend({
        sessionId: "s1",
        selectedModelProvider: {},
        agentBackends: [],
        defaultAgentBackendId: "anthropic",
      }),
    ).toBeNull();
  });
});
