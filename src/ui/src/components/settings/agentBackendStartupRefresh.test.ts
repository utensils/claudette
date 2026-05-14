import { describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig } from "../../services/tauri";
import {
  refreshStartupCodexBackends,
  shouldShowBackendTestButton,
  startupRefreshBackendIds,
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

describe("startupRefreshBackendIds", () => {
  it("selects only enabled native Codex backends for startup refresh", () => {
    expect(
      startupRefreshBackendIds([
        backend({ id: "codex", kind: "codex_native", enabled: true }),
        backend({ id: "codex-off", kind: "codex_native", enabled: false }),
        backend({ id: "legacy", kind: "codex_subscription", enabled: true }),
        backend({ id: "openai", kind: "openai_api", enabled: true }),
      ]),
    ).toEqual(["codex"]);
  });
});

describe("refreshStartupCodexBackends", () => {
  it("refreshes matching Codex backends without blocking initial backend display", async () => {
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
    const refreshBackend = vi.fn().mockResolvedValue(refreshedBackends);
    const onBackends = vi.fn();

    await refreshStartupCodexBackends({
      backends: initialBackends,
      refreshBackend,
      onBackends,
      onError: vi.fn(),
    });

    expect(refreshBackend).toHaveBeenCalledWith("codex");
    expect(refreshBackend).toHaveBeenCalledTimes(1);
    expect(onBackends).toHaveBeenCalledWith(refreshedBackends);
  });

  it("logs refresh failures without throwing", async () => {
    const error = new Error("not logged in");
    const refreshBackend = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();

    await expect(
      refreshStartupCodexBackends({
        backends: [backend({ id: "codex", kind: "codex_native" })],
        refreshBackend,
        onBackends: vi.fn(),
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith("codex", error);
  });
});
