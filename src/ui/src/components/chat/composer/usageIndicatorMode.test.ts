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
    expect(resolveIndicatorMode(null)).toBe("hidden");
    expect(resolveIndicatorMode(undefined)).toBe("hidden");
  });

  it("Claude-family kinds: active by default", () => {
    // These read the official Claude Code `/usage` screen through
    // ptywright. Codex Subscription is intentionally NOT here even
    // though its default harness is `claude_code` — its auth lives in
    // the Codex CLI ecosystem.
    const claudeKinds: AgentBackendKind[] = [
      "anthropic",
      "custom_anthropic",
    ];
    for (const kind of claudeKinds) {
      const backend = makeBackend(kind);
      expect(resolveIndicatorMode(backend)).toBe("active");
    }
  });

  it("Codex Subscription is active from its own usage source", () => {
    // Codex Subscription uses Codex CLI auth, so it renders the live
    // local-aggregate / Codex meter rather than Claude Code quotas.
    const backend = makeBackend("codex_subscription");
    expect(resolveIndicatorMode(backend)).toBe("active");
  });

  it("non-Claude kinds with default harness: always active", () => {
    const alwaysActive: AgentBackendKind[] = [
      "codex_native",
      "codex_subscription",
      "openai_api",
      "custom_openai",
      "ollama",
      "lm_studio",
      "pi_sdk",
    ];
    for (const kind of alwaysActive) {
      const backend = makeBackend(kind);
      expect(resolveIndicatorMode(backend)).toBe("active");
    }
  });

  it("harness override doesn't change the gating decision", () => {
    // Ollama pinned back to the Claude CLI gateway still uses local-
    // aggregate data (Claudette's own per-turn token counts).
    const backend = makeBackend("ollama", "claude_code");
    expect(resolveIndicatorMode(backend)).toBe("active");
  });

  it("OpenAI / OpenRouter on default harness: always active", () => {
    // OpenAI / Custom OpenAI default to `claude_code` for gateway
    // translation, but the meter still runs on local-aggregate data
    // (not Claude Code subscription quotas).
    const openai = makeBackend("openai_api");
    expect(resolveIndicatorMode(openai)).toBe("active");

    const openrouter = makeBackend("custom_openai");
    expect(resolveIndicatorMode(openrouter)).toBe("active");
  });

  it("Codex Native is active", () => {
    const backend = makeBackend("codex_native");
    expect(resolveIndicatorMode(backend)).toBe("active");
  });
});
