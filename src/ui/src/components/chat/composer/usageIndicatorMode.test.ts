import { describe, expect, it } from "vitest";

import type {
  AgentBackendConfig,
  AgentBackendKind,
  AgentBackendRuntimeHarness,
} from "../../../services/tauri/agentBackends";
import { resolveIndicatorMode } from "./usageIndicatorMode";

function makeBackend(
  kind: AgentBackendKind,
  runtimeHarness?: AgentBackendRuntimeHarness | null,
): AgentBackendConfig {
  return {
    id: `id-${kind}`,
    label: kind,
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
    runtime_harness: runtimeHarness ?? null,
  };
}

describe("resolveIndicatorMode", () => {
  it("hides when no backend is loaded", () => {
    expect(resolveIndicatorMode(null, true)).toBe("hidden");
    expect(resolveIndicatorMode(undefined, false)).toBe("hidden");
  });

  it("Claude-family kinds: disabled when flag off, active when on", () => {
    const claudeKinds: AgentBackendKind[] = [
      "anthropic",
      "custom_anthropic",
      "codex_subscription",
    ];
    for (const kind of claudeKinds) {
      const backend = makeBackend(kind);
      expect(resolveIndicatorMode(backend, false)).toBe("disabled");
      expect(resolveIndicatorMode(backend, true)).toBe("active");
    }
  });

  it("non-Claude kinds with default harness: always active", () => {
    const alwaysActive: AgentBackendKind[] = [
      "codex_native",
      "openai_api",
      "custom_openai",
      "ollama",
      "lm_studio",
      "pi_sdk",
    ];
    for (const kind of alwaysActive) {
      const backend = makeBackend(kind);
      expect(resolveIndicatorMode(backend, false)).toBe("active");
      expect(resolveIndicatorMode(backend, true)).toBe("active");
    }
  });

  it("harness override doesn't change the gating decision", () => {
    // Ollama pinned back to the Claude CLI gateway still uses local-
    // aggregate data (Claudette's own per-turn token counts) — no OAuth
    // credential is at stake, so the experimental flag doesn't apply.
    const backend = makeBackend("ollama", "claude_code");
    expect(resolveIndicatorMode(backend, false)).toBe("active");
    expect(resolveIndicatorMode(backend, true)).toBe("active");
  });

  it("OpenAI / OpenRouter on default harness: always active", () => {
    // OpenAI / Custom OpenAI default to `claude_code` for gateway
    // translation, but the meter still runs on local-aggregate data
    // (no OAuth Usage API call). Experimental flag must not gate it.
    const openai = makeBackend("openai_api");
    expect(resolveIndicatorMode(openai, false)).toBe("active");
    expect(resolveIndicatorMode(openai, true)).toBe("active");

    const openrouter = makeBackend("custom_openai");
    expect(resolveIndicatorMode(openrouter, false)).toBe("active");
    expect(resolveIndicatorMode(openrouter, true)).toBe("active");
  });

  it("Codex Native ignores the experimental flag", () => {
    const backend = makeBackend("codex_native");
    expect(resolveIndicatorMode(backend, false)).toBe("active");
    expect(resolveIndicatorMode(backend, true)).toBe("active");
  });
});
