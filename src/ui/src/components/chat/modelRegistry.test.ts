import { describe, it, expect } from "vitest";
import {
  MODELS,
  buildModelRegistry,
  findModelInRegistry,
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

  // `"opus"` is the 1M alias of Opus 4.7 whose id lacks the `[1m]` suffix
  // other 1M variants use. Keep the explicit `id === "opus"` check — removing
  // it would silently misclassify the alias as a 200k model.
  it("1M-context variants report 1_000_000", () => {
    const oneM = MODELS.filter((m) => m.id === "opus" || m.id.endsWith("[1m]"));
    expect(oneM.length).toBeGreaterThan(0);
    for (const m of oneM) {
      expect(m.contextWindowTokens, m.id).toBe(1_000_000);
    }
  });

  it("standard variants report 200_000", () => {
    const standard = MODELS.filter((m) => m.id !== "opus" && !m.id.endsWith("[1m]"));
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
      expect(get1mFallback("opus")).toBe("claude-opus-4-7");
      expect(get1mFallback("claude-sonnet-4-6[1m]")).toBe("sonnet");
      expect(get1mFallback("claude-opus-4-6[1m]")).toBe("claude-opus-4-6");
    });

    it("returns non-1M models unchanged", () => {
      expect(get1mFallback("sonnet")).toBe("sonnet");
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
        expect(target!.contextWindowTokens, `${m.id} → ${fallback} should be non-1M`).toBeLessThan(1_000_000);
      }
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

    it("exposes Pi models as a first-class harness even when alternative backends are disabled", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "pi",
          label: "Pi",
          kind: "pi_sdk",
          enabled: true,
          capabilities: {
            thinking: true,
            effort: true,
            fast_mode: false,
          },
          manual_models: [
            {
              id: "openai/gpt-5.4",
              label: "GPT-5.4",
              context_window_tokens: 400_000,
            },
          ],
          discovered_models: [],
        },
      ]);

      const pi = registry.find((model) => model.providerQualifiedId === "pi/openai/gpt-5.4");
      expect(pi).toBeDefined();
      expect(pi?.group).toBe("Pi");
      expect(pi?.providerLabel).toBe("Pi");
      expect(pi?.supportsEffort).toBe(true);
      expect(pi?.supportsFastMode).toBe(false);
    });

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
