import { describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig } from "../../services/tauri";
import {
  autoDetectStartupAgentBackends,
  autoDetectableBackendIds,
  shouldShowBackendTestButton,
} from "./agentBackendStartupRefresh";

const capabilities = {
  thinking: true,
  effort: true,
  fast_mode: true,
  one_m_context: false,
  tools: true,
  vision: false,
};

function backend(
  overrides: Partial<AgentBackendConfig> = {},
): AgentBackendConfig {
  return {
    id: "backend-id",
    label: "Backend",
    kind: "openai_api",
    base_url: null,
    enabled: true,
    default_model: null,
    manual_models: [],
    discovered_models: [],
    auth_ref: null,
    capabilities,
    context_window_default: 200_000,
    model_discovery: true,
    has_secret: false,
    ...overrides,
  };
}

describe("shouldShowBackendTestButton", () => {
  it("hides the manual test action for native Codex", () => {
    expect(
      shouldShowBackendTestButton(backend({ kind: "codex_native" })),
    ).toBe(false);
  });

  it("keeps the manual test action for non-Codex backends", () => {
    expect(shouldShowBackendTestButton(backend({ kind: "openai_api" }))).toBe(true);
    expect(shouldShowBackendTestButton(backend({ kind: "lm_studio" }))).toBe(true);
    expect(shouldShowBackendTestButton(backend({ kind: "ollama" }))).toBe(true);
  });
});

describe("autoDetectableBackendIds", () => {
  it("selects local and CLI providers for startup detection", () => {
    expect(
      autoDetectableBackendIds([
        backend({ id: "codex", kind: "codex_native", enabled: true }),
        backend({ id: "ollama", kind: "ollama", enabled: false }),
        backend({ id: "lm-studio", kind: "lm_studio", enabled: false }),
        backend({ id: "codex-off", kind: "codex_native", enabled: false }),
        backend({ id: "pi", kind: "pi_sdk", enabled: true }),
        backend({ id: "pi-off", kind: "pi_sdk", enabled: false }),
        backend({ id: "legacy", kind: "codex_subscription", enabled: true }),
        backend({ id: "openai", kind: "openai_api", enabled: true }),
      ]).sort(),
    ).toEqual(["codex", "codex-off", "lm-studio", "ollama"]);
  });

  it("excludes pi_sdk backends until the Tauri auto-detect command probes them", () => {
    expect(
      autoDetectableBackendIds([
        backend({ id: "pi", kind: "pi_sdk", enabled: true }),
        backend({ id: "pi-off", kind: "pi_sdk", enabled: false }),
      ]),
    ).toEqual([]);
  });
});

describe("autoDetectStartupAgentBackends", () => {
  it("runs provider detection without blocking initial backend display", async () => {
    const initialBackends = [
      backend({ id: "openai", kind: "openai_api" }),
      backend({ id: "codex", kind: "codex_native" }),
    ];
    const refreshedBackends = [
      backend({ id: "codex", kind: "codex_native", discovered_models: [
        {
          id: "gpt-5.4",
          label: "gpt-5.4",
          context_window_tokens: 400_000,
          discovered: true,
        },
      ] }),
    ];
    const autoDetectBackends = vi.fn().mockResolvedValue({
      backends: refreshedBackends,
      default_backend_id: "codex",
      warnings: [],
    });
    const onBackends = vi.fn();
    const onDefaultBackend = vi.fn();

    await autoDetectStartupAgentBackends({
      backends: initialBackends,
      autoDetectBackends,
      onBackends,
      onDefaultBackend,
      onError: vi.fn(),
    });

    expect(autoDetectBackends).toHaveBeenCalledTimes(1);
    expect(onBackends).toHaveBeenCalledWith(refreshedBackends);
    expect(onDefaultBackend).toHaveBeenCalledWith("codex");
  });

  it("logs detection failures without throwing", async () => {
    const error = new Error("not logged in");
    const autoDetectBackends = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();

    await expect(
      autoDetectStartupAgentBackends({
        backends: [backend({ id: "codex", kind: "codex_native" })],
        autoDetectBackends,
        onBackends: vi.fn(),
        onDefaultBackend: vi.fn(),
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
