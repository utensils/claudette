// @vitest-environment happy-dom

/// Pin the behaviour of `effectiveHarness` so a regression where the
/// `claude_interactive` override silently falls back to the kind's
/// default (because the matrix gate is the experimental flag, not
/// `availableHarnessesForKind`) shows up in CI rather than as a
/// frontend/backend state mismatch at runtime.
///
/// Mirrors the Rust-side `AgentBackendConfig::effective_harness_kind`
/// in `src/agent_backend.rs`.

import { describe, expect, it, vi } from "vitest";

// `agentBackends.ts` imports `invoke` at the top of the module, so the
// Tauri bridge has to be mocked even though these tests only exercise
// pure helper functions.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  type AgentBackendConfig,
  availableHarnessesForKind,
  effectiveHarness,
} from "./agentBackends";

function backend(overrides: Partial<AgentBackendConfig> = {}): AgentBackendConfig {
  return {
    id: "test",
    label: "Test",
    kind: "ollama",
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
    context_window_default: 64_000,
    model_discovery: true,
    has_secret: false,
    ...overrides,
  };
}

describe("effectiveHarness", () => {
  it("returns the kind's default harness when the override is 'claude_interactive' and the flag is OFF", () => {
    // Ollama's default is `pi_sdk`; `claude_interactive` is never in
    // `availableHarnessesForKind`, so without the flag the override
    // must be discarded and we should land on the kind default rather
    // than silently dispatch into the gated harness.
    const config = backend({
      kind: "ollama",
      runtime_harness: "claude_interactive",
    });
    expect(
      effectiveHarness(config, { claudeInteractiveEnabled: false }),
    ).toBe("pi_sdk");
    // Same expectation when the caller doesn't pass the option at all.
    expect(effectiveHarness(config)).toBe("pi_sdk");
  });

  it("honors a 'claude_interactive' override when the flag is ON", () => {
    const config = backend({
      kind: "ollama",
      runtime_harness: "claude_interactive",
    });
    expect(
      effectiveHarness(config, { claudeInteractiveEnabled: true }),
    ).toBe("claude_interactive");
  });

  it("honors a 'claude_code' override for a kind that allows it, regardless of the flag (no regression)", () => {
    // openai_api supports both `claude_code` and `pi_sdk`; pinning
    // `claude_code` must still work whether or not the experimental
    // flag is on.
    const config = backend({
      kind: "openai_api",
      runtime_harness: "claude_code",
    });
    expect(
      effectiveHarness(config, { claudeInteractiveEnabled: true }),
    ).toBe("claude_code");
    expect(
      effectiveHarness(config, { claudeInteractiveEnabled: false }),
    ).toBe("claude_code");
  });

  it("falls back to the kind's default when the override is missing", () => {
    const config = backend({ kind: "anthropic", runtime_harness: null });
    expect(effectiveHarness(config)).toBe("claude_code");
  });

  it("falls back to the kind's default when the override isn't in the kind's available set", () => {
    // anthropic's available harnesses are `["claude_code"]`; a stale /
    // hand-edited `pi_sdk` override should be ignored.
    const config = backend({
      kind: "anthropic",
      runtime_harness: "pi_sdk",
    });
    expect(
      effectiveHarness(config, { claudeInteractiveEnabled: true }),
    ).toBe("claude_code");
  });
});

describe("availableHarnessesForKind", () => {
  it("omits claude_interactive from every kind when the flag is OFF (default)", () => {
    // Back-compat baseline: callers without the option get the static
    // matrix, identical to the pre-FB-1 behaviour.
    const kinds = [
      "anthropic",
      "custom_anthropic",
      "codex_subscription",
      "ollama",
      "lm_studio",
      "openai_api",
      "custom_openai",
      "codex_native",
      "pi_sdk",
    ] as const;
    for (const kind of kinds) {
      const harnesses = availableHarnessesForKind(kind);
      expect(harnesses).not.toContain("claude_interactive");
      // And explicit `false` matches the default-undefined case.
      expect(
        availableHarnessesForKind(kind, { claudeInteractiveEnabled: false }),
      ).toEqual(harnesses);
    }
  });

  it("appends claude_interactive for Anthropic / CustomAnthropic / CodexSubscription when the flag is ON", () => {
    for (const kind of ["anthropic", "custom_anthropic", "codex_subscription"] as const) {
      expect(
        availableHarnessesForKind(kind, { claudeInteractiveEnabled: true }),
      ).toEqual(["claude_code", "claude_interactive"]);
    }
  });

  it("does not append claude_interactive for non-Claude-flavored kinds even when the flag is ON", () => {
    // ClaudeInteractive is a Claude-runtime variant — Pi, Ollama, LM
    // Studio, OpenAI-flavored, and Codex Native must never surface it.
    const kinds = [
      "ollama",
      "lm_studio",
      "openai_api",
      "custom_openai",
      "codex_native",
      "pi_sdk",
    ] as const;
    for (const kind of kinds) {
      const withFlag = availableHarnessesForKind(kind, {
        claudeInteractiveEnabled: true,
      });
      const withoutFlag = availableHarnessesForKind(kind);
      expect(withFlag).not.toContain("claude_interactive");
      expect(withFlag).toEqual(withoutFlag);
    }
  });
});
