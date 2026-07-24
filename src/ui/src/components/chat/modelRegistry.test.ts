import { describe, it, expect } from "vitest";
import {
  MODELS,
  buildModelRegistry,
  findModelInRegistry,
  getHarnessForModel,
  is1mContextModel,
  get1mFallback,
} from "./modelRegistry";

describe("modelRegistry", () => {
  it("every model has a positive integer contextWindowTokens", () => {
    for (const m of MODELS) {
      expect(m.contextWindowTokens, `model ${m.id} is missing contextWindowTokens`).toBeTypeOf("number");
      expect(m.contextWindowTokens, `model ${m.id} has non-positive contextWindowTokens`).toBeGreaterThan(0);
      expect(Number.isInteger(m.contextWindowTokens), `model ${m.id} has non-integer contextWindowTokens`).toBe(true);
    }
  });

  // `"opus"` and `"sonnet"` are bare 1M aliases whose ids lack the `[1m]`
  // suffix other 1M variants use (opus auto-upgrades to 1M; Sonnet 5 is
  // natively 1M). Keep the explicit id checks — removing either would
  // silently misclassify the alias as a 200k model.
  it("1M-context variants report 1_000_000", () => {
    const oneM = MODELS.filter((m) => m.id === "opus" || m.id === "sonnet" || m.id.endsWith("[1m]"));
    expect(oneM.length).toBeGreaterThan(0);
    for (const m of oneM) {
      expect(m.contextWindowTokens, m.id).toBe(1_000_000);
    }
  });

  it("standard variants report 200_000", () => {
    const standard = MODELS.filter((m) => m.id !== "opus" && m.id !== "sonnet" && !m.id.endsWith("[1m]"));
    expect(standard.length).toBeGreaterThan(0);
    for (const m of standard) {
      expect(m.contextWindowTokens, m.id).toBe(200_000);
    }
  });

  describe("is1mContextModel", () => {
    it("returns true for 1M-context models", () => {
      const oneM = MODELS.filter((m) => m.contextWindowTokens >= 1_000_000);
      expect(oneM.length).toBeGreaterThan(0);
      for (const m of oneM) {
        expect(is1mContextModel(m.id), m.id).toBe(true);
      }
    });

    it("returns false for standard-context models", () => {
      const standard = MODELS.filter((m) => m.contextWindowTokens < 1_000_000);
      expect(standard.length).toBeGreaterThan(0);
      for (const m of standard) {
        expect(is1mContextModel(m.id), m.id).toBe(false);
      }
    });

    it("returns false for unknown model IDs", () => {
      expect(is1mContextModel("unknown-model")).toBe(false);
    });
  });

  describe("get1mFallback", () => {
    it("maps 1M models to their 200K equivalents", () => {
      expect(get1mFallback("claude-fable-5[1m]")).toBe("claude-fable-5");
      // Opus 4.8 1M now falls back to the pinned 200K id, not the `opus`
      // alias (which moved to Opus 5).
      expect(get1mFallback("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
      expect(get1mFallback("claude-opus-4-7[1m]")).toBe("claude-opus-4-7");
      // Sonnet 4.6 1M now falls back to the pinned 200K id, not the `sonnet`
      // alias (which moved to Sonnet 5).
      expect(get1mFallback("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
      expect(get1mFallback("claude-opus-4-6[1m]")).toBe("claude-opus-4-6");
    });

    it("returns the `opus` alias unchanged (Opus 5 is natively 1M, no 200K variant)", () => {
      expect(get1mFallback("opus")).toBe("opus");
    });

    it("returns the `sonnet` alias unchanged (Sonnet 5 is natively 1M, no 200K variant)", () => {
      expect(get1mFallback("sonnet")).toBe("sonnet");
    });

    it("returns non-1M models unchanged", () => {
      expect(get1mFallback("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
      expect(get1mFallback("claude-opus-4-7")).toBe("claude-opus-4-7");
      expect(get1mFallback("haiku")).toBe("haiku");
    });

    it("returns unknown model IDs unchanged", () => {
      expect(get1mFallback("unknown-model")).toBe("unknown-model");
    });

    it("every 1M model has a fallback that exists in the registry", () => {
      const oneM = MODELS.filter((m) => m.contextWindowTokens >= 1_000_000);
      for (const m of oneM) {
        const fallback = get1mFallback(m.id);
        const target = MODELS.find((t) => t.id === fallback);
        expect(target, `${m.id} → ${fallback} not in MODELS`).toBeDefined();
        // The fallback is either a strictly-smaller (200K) model, or the model
        // itself when it is natively 1M with no 200K variant (Sonnet 5 — the CLI
        // caps it to 200K under the same id rather than swapping to another model).
        if (fallback !== m.id) {
          expect(target!.contextWindowTokens, `${m.id} → ${fallback} should be non-1M`).toBeLessThan(1_000_000);
        }
      }
    });
  });

  describe("getHarnessForModel", () => {
    it("returns claude_code for curated Claude Code entries that have no runtimeHarness field", () => {
      expect(getHarnessForModel(MODELS, "sonnet", "anthropic")).toBe("claude_code");
      expect(getHarnessForModel(MODELS, "opus", "anthropic")).toBe("claude_code");
      expect(getHarnessForModel(MODELS, "claude-opus-4-7", "anthropic")).toBe("claude_code");
      expect(getHarnessForModel(MODELS, "haiku", "anthropic")).toBe("claude_code");
    });

    it("returns the backend's effective harness for backend-injected entries", () => {
      const registry = buildModelRegistry(true, [
        {
          id: "openai-api",
          label: "OpenAI API",
          kind: "openai_api",
          enabled: true,
          capabilities: { thinking: false, effort: false, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "gpt-5.4", label: "gpt-5.4", context_window_tokens: 272_000 },
          ],
        },
      ]);
      expect(getHarnessForModel(registry, "gpt-5.4", "openai-api")).toBe("claude_code");
    });

    it("returns codex_app_server for native Codex models", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "codex-native",
          label: "Codex Native",
          kind: "codex_native",
          enabled: true,
          capabilities: { thinking: true, effort: true, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "gpt-5.4", label: "gpt-5.4", context_window_tokens: 272_000 },
          ],
        },
      ], /* codexEnabled */ true);
      expect(getHarnessForModel(registry, "gpt-5.4", "codex-native")).toBe("codex_app_server");
    });

    it("returns undefined for unknown models", () => {
      expect(getHarnessForModel(MODELS, "nonexistent-model")).toBeUndefined();
      expect(getHarnessForModel(MODELS, undefined)).toBeUndefined();
    });
  });

  describe("buildModelRegistry", () => {
    it("hides backend models when alternative backends are disabled", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "codex-subscription",
          label: "Codex",
          kind: "codex_subscription",
          enabled: true,
          capabilities: {
            thinking: false,
            effort: false,
            fast_mode: false,
          },
          manual_models: [],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 272_000,
            },
          ],
        },
      ]);

      expect(registry).toBe(MODELS);
      expect(registry.find((model) => model.providerQualifiedId === "codex-subscription/gpt-5.4")).toBeUndefined();
    });

    it("exposes discovered backend models and prefers them over manual fallbacks", () => {
      const registry = buildModelRegistry(true, [
        {
          id: "openai-api",
          label: "OpenAI API",
          kind: "openai_api",
          enabled: true,
          capabilities: {
            thinking: false,
            effort: false,
            fast_mode: false,
          },
          manual_models: [
            {
              id: "manual-fallback",
              label: "Manual fallback",
              context_window_tokens: 400_000,
            },
          ],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 272_000,
            },
            {
              id: "gpt-5.3-codex",
              label: "gpt-5.3-codex",
              context_window_tokens: 272_000,
            },
          ],
        },
      ]);

      expect(registry.find((model) => model.providerQualifiedId === "openai-api/gpt-5.4")).toBeDefined();
      expect(registry.find((model) => model.providerQualifiedId === "openai-api/gpt-5.3-codex")).toBeDefined();
      expect(registry.find((model) => model.providerQualifiedId === "openai-api/manual-fallback")).toBeUndefined();
    });

    it("exposes native Codex models and normalizes stale capability metadata", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "codex",
          label: "Codex",
          kind: "codex_native",
          enabled: true,
          capabilities: {
            thinking: false,
            effort: false,
            fast_mode: false,
          },
          manual_models: [
            {
              id: "gpt-5.4",
              label: "GPT-5.4",
              context_window_tokens: 400_000,
            },
          ],
          discovered_models: [],
        },
      ], true);

      const codex = registry.find((model) => model.providerQualifiedId === "codex/gpt-5.4");
      expect(codex).toBeDefined();
      expect(codex?.group).toBe("Codex");
      expect(codex?.providerLabel).toBe("Codex");
      expect(codex?.supportsThinking).toBe(true);
      expect(codex?.supportsEffort).toBe(true);
      expect(codex?.supportsFastMode).toBe(true);
    });

  });

  describe("runtimeHarness on flat-backend models", () => {
    it("tags Ollama models with the Claude CLI gateway by default", () => {
      // Ollama's `available_harnesses` is now `[claude_code]`, so the
      // implicit default the picker surfaces is the Claude CLI gateway.
      const registry = buildModelRegistry(true, [
        {
          id: "ollama",
          label: "Ollama",
          kind: "ollama",
          enabled: true,
          capabilities: { thinking: false, effort: false, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "llama3", label: "llama3", context_window_tokens: 128_000 },
          ],
        },
      ]);
      const llama = registry.find((m) => m.id === "llama3");
      expect(llama?.runtimeHarness).toBe("claude_code");
      expect(llama?.providerKind).toBe("ollama");
    });

    it("ignores an out-of-bounds runtime override (defense in depth)", () => {
      // Mirror of the Rust `effective_harness_ignores_override_not_in_available_set`
      // test: a persisted value outside the kind's allow-list silently
      // resolves to the default rather than crossing the routing gate.
      // Uses a Custom-Anthropic-shaped row (allow-list is `["claude_code"]`)
      // so the built-in `id === "anthropic"` filter in
      // `shouldExposeBackendModels` doesn't suppress the test fixture.
      const registry = buildModelRegistry(true, [
        {
          id: "claude-proxy",
          label: "Claude Proxy",
          kind: "custom_anthropic",
          enabled: true,
          runtime_harness: "codex_app_server", // not in Custom-Anthropic's allow-list
          capabilities: { thinking: true, effort: false, fast_mode: false },
          manual_models: [],
          discovered_models: [
            {
              id: "claude-test",
              label: "Claude Test",
              context_window_tokens: 200_000,
            },
          ],
        },
      ]);
      const claude = registry.find((m) => m.id === "claude-test");
      expect(claude?.runtimeHarness).toBe("claude_code");
    });
  });

  describe("backend model exposure & ordering", () => {
    it("does not expose legacy Codex through alternative backends", () => {
      const registry = buildModelRegistry(true, [
        {
          id: "codex-subscription",
          label: "Codex",
          kind: "codex_subscription",
          enabled: true,
          capabilities: {
            thinking: false,
            effort: false,
            fast_mode: false,
          },
          manual_models: [],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 272_000,
            },
          ],
        },
      ]);

      expect(registry.find((model) => model.providerQualifiedId === "codex-subscription/gpt-5.4")).toBeUndefined();
    });

    it("orders versioned backend models newest first and moves older bands to More", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "codex",
          label: "Codex",
          kind: "codex_native",
          enabled: true,
          capabilities: {
            thinking: true,
            effort: true,
            fast_mode: true,
          },
          manual_models: [],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 400_000,
            },
            {
              id: "gpt-5.2",
              label: "gpt-5.2",
              context_window_tokens: 400_000,
            },
            {
              id: "gpt-5.3-codex",
              label: "gpt-5.3-codex",
              context_window_tokens: 400_000,
            },
            {
              id: "gpt-5.5",
              label: "GPT-5.5",
              context_window_tokens: 400_000,
            },
            {
              id: "gpt-5.3-codex-spark",
              label: "GPT-5.3-Codex-Spark",
              context_window_tokens: 400_000,
            },
            {
              id: "gpt-5.4-mini",
              label: "GPT-5.4-Mini",
              context_window_tokens: 400_000,
            },
          ],
        },
      ], true);

      const codexModels = registry.filter(
        (model) => model.providerId === "codex",
      );
      expect(codexModels.map((model) => model.id)).toEqual([
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.2",
      ]);
      expect(
        codexModels
          .filter((model) => !model.legacy)
          .map((model) => model.id),
      ).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
      expect(
        codexModels
          .filter((model) => model.legacy)
          .map((model) => model.id),
      ).toEqual(["gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"]);
    });
  });

  describe("findModelInRegistry", () => {
    it("uses provider when backend model ids overlap", () => {
      const registry = buildModelRegistry(true, [
        {
          id: "openai-api",
          label: "OpenAI API",
          kind: "openai_api",
          enabled: true,
          capabilities: {
            thinking: false,
            effort: false,
            fast_mode: false,
          },
          manual_models: [],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 272_000,
            },
          ],
        },
        {
          id: "codex",
          label: "Codex",
          kind: "codex_native",
          enabled: true,
          capabilities: {
            thinking: true,
            effort: false,
            fast_mode: true,
          },
          manual_models: [],
          discovered_models: [
            {
              id: "gpt-5.4",
              label: "gpt-5.4",
              context_window_tokens: 1_000_000,
            },
          ],
        },
      ], true);

      expect(
        findModelInRegistry(registry, "gpt-5.4", "codex")
          ?.contextWindowTokens,
      ).toBe(1_000_000);
      expect(
        findModelInRegistry(registry, "gpt-5.4", "openai-api")
          ?.contextWindowTokens,
      ).toBe(272_000);
    });
  });
});
