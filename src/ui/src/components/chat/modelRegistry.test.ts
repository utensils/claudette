import { describe, it, expect } from "vitest";
import {
  MODELS,
  PI_SUBSECTION_PRIMARY_CAP,
  buildModelRegistry,
  findModelInRegistry,
  groupPiDiscoveredModels,
  is1mContextModel,
  get1mFallback,
  resolvePiSubProvider,
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
      expect(pi?.subProvider).toBe("OpenAI");
      expect(pi?.subProviderKey).toBe("openai");
      expect(pi?.supportsEffort).toBe(true);
      expect(pi?.supportsFastMode).toBe(false);
    });

    it("splits Pi models into sub-sections derived from their provider/modelId prefix", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "pi",
          label: "Pi",
          kind: "pi_sdk",
          enabled: true,
          capabilities: { thinking: true, effort: true, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "openai/gpt-5.4", label: "GPT-5.4", context_window_tokens: 272_000 },
            { id: "openai/gpt-4o", label: "GPT-4o", context_window_tokens: 128_000 },
            { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", context_window_tokens: 200_000 },
            { id: "ollama/gpt-oss:120b", label: "gpt-oss:120b", context_window_tokens: 64_000 },
          ],
        },
      ]);

      const piModels = registry.filter((model) => model.providerKind === "pi_sdk");
      const subProviderKeys = Array.from(
        new Set(piModels.map((model) => model.subProviderKey)),
      );
      expect(subProviderKeys.sort()).toEqual(["anthropic", "ollama", "openai"]);
      const subProviderLabels = new Map(
        piModels.map((model) => [model.subProviderKey, model.subProvider]),
      );
      expect(subProviderLabels.get("openai")).toBe("OpenAI");
      expect(subProviderLabels.get("anthropic")).toBe("Anthropic");
      expect(subProviderLabels.get("ollama")).toBe("Ollama");
    });

    it("marks Pi sub-section overflow as legacy without crossing sub-providers", () => {
      // Use distinct, non-numeric model names so the version-band ranker
      // doesn't demote them on its own — this test isolates the per-
      // sub-section cap.
      const codenames = [
        "atlas",
        "babbage",
        "curie",
        "davinci",
        "echo",
        "foxtrot",
        "golf",
        "hotel",
      ];
      const surplus = codenames.length;
      expect(surplus).toBeGreaterThan(PI_SUBSECTION_PRIMARY_CAP);
      const openaiModels = codenames.map((name) => ({
        id: `openai/${name}`,
        label: name,
        context_window_tokens: 200_000,
      }));
      const registry = buildModelRegistry(false, [
        {
          id: "pi",
          label: "Pi",
          kind: "pi_sdk",
          enabled: true,
          capabilities: { thinking: true, effort: true, fast_mode: false },
          manual_models: [],
          discovered_models: [
            ...openaiModels,
            // A second sub-provider with one entry — must stay primary
            // even though OpenAI ran past its cap.
            {
              id: "anthropic/claude-sonnet-4-6",
              label: "Claude Sonnet 4.6",
              context_window_tokens: 200_000,
            },
          ],
        },
      ]);

      const openaiPrimary = registry.filter(
        (m) => m.subProviderKey === "openai" && !m.legacy,
      );
      const openaiOverflow = registry.filter(
        (m) => m.subProviderKey === "openai" && m.legacy,
      );
      expect(openaiPrimary.length).toBe(PI_SUBSECTION_PRIMARY_CAP);
      expect(openaiOverflow.length).toBe(surplus - PI_SUBSECTION_PRIMARY_CAP);
      const anthropic = registry.find(
        (m) => m.subProviderKey === "anthropic",
      );
      expect(anthropic?.legacy).toBeFalsy();
    });

    it("hides Pi Anthropic and Claude sub-providers from every consumer when Claude OAuth is active", () => {
      // The Rust resolver refuses Pi-routed `anthropic/*` or `claude/*`
      // selections under a Pro/Max OAuth subscription, so every consumer
      // of `buildModelRegistry` (chat picker, Settings default-model
      // dropdown, `/model` slash command, toolbars) needs the same set
      // hidden — gating only at the picker would let a Settings save
      // commit `pi/anthropic/...` and fail the next send.
      const backends = [
        {
          id: "pi",
          label: "Pi",
          kind: "pi_sdk" as const,
          enabled: true,
          capabilities: { thinking: true, effort: true, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", context_window_tokens: 200_000 },
            { id: "claude/legacy-sonnet", label: "Legacy Sonnet (claude prefix)", context_window_tokens: 200_000 },
            { id: "openai/gpt-5.4", label: "GPT-5.4", context_window_tokens: 272_000 },
            { id: "ollama/gpt-oss:120b", label: "gpt-oss:120b", context_window_tokens: 64_000 },
          ],
        },
      ];

      const oauthRegistry = buildModelRegistry(false, backends, false, {
        isClaudeOauthSubscriber: true,
      });
      const remainingPiSubKeys = new Set(
        oauthRegistry
          .filter((m) => m.providerKind === "pi_sdk")
          .map((m) => m.subProviderKey),
      );
      expect(remainingPiSubKeys.has("anthropic")).toBe(false);
      expect(remainingPiSubKeys.has("claude")).toBe(false);
      // Other Pi sub-providers remain reachable — the gate is narrow.
      expect(remainingPiSubKeys.has("openai")).toBe(true);
      expect(remainingPiSubKeys.has("ollama")).toBe(true);

      // Without the flag, Anthropic + Claude Pi sub-providers are still
      // exposed (API-key users, non-OAuth profiles).
      const apiKeyRegistry = buildModelRegistry(false, backends, false);
      const apiKeyPiSubKeys = new Set(
        apiKeyRegistry
          .filter((m) => m.providerKind === "pi_sdk")
          .map((m) => m.subProviderKey),
      );
      expect(apiKeyPiSubKeys.has("anthropic")).toBe(true);
      expect(apiKeyPiSubKeys.has("claude")).toBe(true);
    });

    it("falls back to title-cased label for unknown Pi providers", () => {
      const registry = buildModelRegistry(false, [
        {
          id: "pi",
          label: "Pi",
          kind: "pi_sdk",
          enabled: true,
          capabilities: { thinking: true, effort: true, fast_mode: false },
          manual_models: [
            { id: "deepseek/coder", label: "Deepseek Coder", context_window_tokens: 128_000 },
          ],
          discovered_models: [],
        },
      ]);
      const deepseek = registry.find((m) => m.id === "deepseek/coder");
      expect(deepseek?.subProvider).toBe("Deepseek");
      expect(deepseek?.subProviderKey).toBe("deepseek");
    });
  });

  describe("runtimeHarness on flat-backend models", () => {
    it("tags Ollama models as Pi-routed by default", () => {
      // Ollama's `available_harnesses` is `[pi_sdk, claude_code]`, so the
      // implicit default the picker has to surface is Pi. The badge needs
      // this to render "via Pi" on the section header.
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
      expect(llama?.runtimeHarness).toBe("pi_sdk");
      expect(llama?.providerKind).toBe("ollama");
    });

    it("respects a persisted runtime override on Ollama (opt-in to Claude CLI)", () => {
      const registry = buildModelRegistry(true, [
        {
          id: "ollama",
          label: "Ollama",
          kind: "ollama",
          enabled: true,
          runtime_harness: "claude_code",
          capabilities: { thinking: false, effort: false, fast_mode: false },
          manual_models: [],
          discovered_models: [
            { id: "llama3", label: "llama3", context_window_tokens: 128_000 },
          ],
        },
      ]);
      const llama = registry.find((m) => m.id === "llama3");
      expect(llama?.runtimeHarness).toBe("claude_code");
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
          runtime_harness: "pi_sdk", // not in Custom-Anthropic's allow-list
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

  describe("resolvePiSubProvider", () => {
    it("splits the provider prefix off provider-qualified ids", () => {
      expect(resolvePiSubProvider("openai/gpt-5.4")).toEqual({
        key: "openai",
        label: "OpenAI",
      });
      expect(resolvePiSubProvider("anthropic/claude-opus-4-5")).toEqual({
        key: "anthropic",
        label: "Anthropic",
      });
    });

    it("returns `other` for ids without a `/` so unknown shapes don't crash the picker", () => {
      expect(resolvePiSubProvider("gpt-5.4")).toEqual({
        key: "other",
        label: "Other",
      });
      expect(resolvePiSubProvider("")).toEqual({
        key: "other",
        label: "Other",
      });
      expect(resolvePiSubProvider("/orphan")).toEqual({
        key: "other",
        label: "Other",
      });
    });
  });

  describe("groupPiDiscoveredModels", () => {
    const m = (id: string) => ({ id, label: id });

    it("groups by provider prefix and sorts by count desc", () => {
      const result = groupPiDiscoveredModels([
        m("openai/gpt-5.4"),
        m("anthropic/claude-sonnet-4-6"),
        m("openai/gpt-4o"),
        m("openai/gpt-5"),
        m("ollama/llama3"),
      ]);
      expect(result.map((g) => g.key)).toEqual(["openai", "anthropic", "ollama"]);
      expect(result[0]!.models).toHaveLength(3);
      expect(result[1]!.models).toHaveLength(1);
      expect(result[2]!.models).toHaveLength(1);
    });

    it("breaks ties alphabetically by display label so order is stable", () => {
      const result = groupPiDiscoveredModels([
        m("openai/gpt-5.4"),
        m("anthropic/claude-sonnet-4-6"),
      ]);
      expect(result.map((g) => g.key)).toEqual(["anthropic", "openai"]);
    });

    it("returns an empty array when given no models", () => {
      expect(groupPiDiscoveredModels([])).toEqual([]);
    });

    it("buckets non-provider-qualified ids under `other` instead of crashing", () => {
      const result = groupPiDiscoveredModels([
        m("openai/gpt-5.4"),
        m("bare-id-with-no-slash"),
      ]);
      const otherGroup = result.find((g) => g.key === "other");
      expect(otherGroup).toBeDefined();
      expect(otherGroup?.models.map((mm) => mm.id)).toEqual([
        "bare-id-with-no-slash",
      ]);
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
