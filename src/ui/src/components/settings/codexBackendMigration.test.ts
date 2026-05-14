import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_BACKEND,
  DEFAULT_CLAUDE_MODEL,
} from "./alternativeBackendCleanup";
import {
  LEGACY_CODEX_BACKEND,
  LEGACY_NATIVE_CODEX_BACKEND,
  NATIVE_CODEX_BACKEND,
  planCodexBackendGateMigration,
  planBackendGateLoad,
  planBackendGateLoadFromResults,
  resolveCodexBackendMigrationModel,
} from "./codexBackendMigration";

describe("planBackendGateLoad", () => {
  it("promotes backend gates on first load when the build includes them", () => {
    const plan = planBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: null,
      codexSetting: null,
      promotionSetting: null,
    });

    expect(plan.alternativeBackendsEnabled).toBe(true);
    expect(plan.codexEnabled).toBe(true);
    expect(plan.shouldPersistPromotion).toBe(true);
  });

  it("respects explicit disabled settings after promotion has run", () => {
    const plan = planBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: "false",
      codexSetting: "false",
      promotionSetting: "true",
    });

    expect(plan.alternativeBackendsEnabled).toBe(false);
    expect(plan.codexEnabled).toBe(false);
    expect(plan.shouldPersistPromotion).toBe(false);
  });

  it("defaults both gates on after promotion when settings are missing", () => {
    const plan = planBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: null,
      codexSetting: null,
      promotionSetting: "true",
    });

    expect(plan.alternativeBackendsEnabled).toBe(true);
    expect(plan.codexEnabled).toBe(true);
    expect(plan.shouldPersistPromotion).toBe(false);
  });

  it("flips saved false values during the one-time promotion", () => {
    const plan = planBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: "false",
      codexSetting: "false",
      promotionSetting: null,
    });

    expect(plan.alternativeBackendsEnabled).toBe(true);
    expect(plan.codexEnabled).toBe(true);
    expect(plan.shouldPersistPromotion).toBe(true);
  });

  it("keeps both gates off when the build omits alternative backend support", () => {
    const plan = planBackendGateLoad({
      alternativeBackendsCompiled: false,
      alternativeBackendsSetting: "true",
      codexSetting: "true",
      promotionSetting: null,
    });

    expect(plan.alternativeBackendsEnabled).toBe(false);
    expect(plan.codexEnabled).toBe(false);
    expect(plan.shouldPersistPromotion).toBe(false);
  });

  it("does not promote or persist gates when a settings read fails", () => {
    const plan = planBackendGateLoadFromResults({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: { status: "rejected", reason: new Error("db busy") },
      codexSetting: { status: "fulfilled", value: "false" },
      promotionSetting: { status: "fulfilled", value: null },
    });

    expect(plan).toBeNull();
  });
});

describe("planCodexBackendGateMigration", () => {
  it("maps legacy Codex defaults and sessions to native Codex when enabled", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: true,
      defaultBackend: LEGACY_NATIVE_CODEX_BACKEND,
      sessionProviders: [
        ["model_provider:sess-1", LEGACY_CODEX_BACKEND],
        ["model_provider:sess-3", LEGACY_NATIVE_CODEX_BACKEND],
      ],
      selectedProviders: { "sess-2": LEGACY_CODEX_BACKEND },
    });

    expect(plan).toEqual({
      fromBackend: LEGACY_CODEX_BACKEND,
      toBackend: NATIVE_CODEX_BACKEND,
      toModel: null,
      defaultBackend: NATIVE_CODEX_BACKEND,
      resetDefault: true,
      sessionIds: ["sess-1", "sess-2", "sess-3"],
    });
  });

  it("resets native Codex defaults and sessions to Claude when disabled", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: false,
      defaultBackend: NATIVE_CODEX_BACKEND,
      sessionProviders: [["model_provider:sess-1", NATIVE_CODEX_BACKEND]],
      selectedProviders: { "sess-2": NATIVE_CODEX_BACKEND },
    });

    expect(plan.toBackend).toBe(DEFAULT_CLAUDE_BACKEND);
    expect(plan.toModel).toBe(DEFAULT_CLAUDE_MODEL);
    expect(plan.defaultBackend).toBe(DEFAULT_CLAUDE_BACKEND);
    expect(plan.resetDefault).toBe(true);
    expect(plan.sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  it("resets legacy Codex defaults and sessions to Claude when disabled", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: false,
      defaultBackend: LEGACY_CODEX_BACKEND,
      sessionProviders: [["model_provider:sess-1", LEGACY_CODEX_BACKEND]],
      selectedProviders: { "sess-2": LEGACY_CODEX_BACKEND },
    });

    expect(plan.toBackend).toBe(DEFAULT_CLAUDE_BACKEND);
    expect(plan.toModel).toBe(DEFAULT_CLAUDE_MODEL);
    expect(plan.defaultBackend).toBe(DEFAULT_CLAUDE_BACKEND);
    expect(plan.resetDefault).toBe(true);
    expect(plan.sessionIds).toEqual(["sess-1", "sess-2"]);
  });

  it("leaves unrelated providers alone", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: true,
      defaultBackend: "ollama",
      sessionProviders: [["model_provider:sess-1", "ollama"]],
      selectedProviders: { "sess-2": "openai-api" },
    });

    expect(plan.defaultBackend).toBe("ollama");
    expect(plan.resetDefault).toBe(false);
    expect(plan.sessionIds).toEqual([]);
  });
});

describe("resolveCodexBackendMigrationModel", () => {
  const nativeBackend = {
    id: NATIVE_CODEX_BACKEND,
    default_model: "gpt-5.2-codex",
    manual_models: [
      {
        id: "gpt-5.2-codex",
      },
      {
        id: "gpt-5.3-codex",
      },
    ],
    discovered_models: [],
  };

  it("preserves a persisted model only when the destination backend supports it", () => {
    const model = resolveCodexBackendMigrationModel({
      plan: {
        toBackend: NATIVE_CODEX_BACKEND,
        toModel: null,
      },
      sessionId: "sess-1",
      persistedModels: new Map([["sess-1", "gpt-5.3-codex"]]),
      selectedModels: {},
      backends: [nativeBackend],
    });

    expect(model).toBe("gpt-5.3-codex");
  });

  it("falls back to the destination backend default for unsupported persisted models", () => {
    const model = resolveCodexBackendMigrationModel({
      plan: {
        toBackend: NATIVE_CODEX_BACKEND,
        toModel: null,
      },
      sessionId: "sess-1",
      persistedModels: new Map([["sess-1", "claude-opus-4-5"]]),
      selectedModels: {},
      backends: [nativeBackend],
    });

    expect(model).toBe("gpt-5.2-codex");
  });

  it("uses the explicit plan model for migrations back to Claude", () => {
    const model = resolveCodexBackendMigrationModel({
      plan: {
        toBackend: DEFAULT_CLAUDE_BACKEND,
        toModel: DEFAULT_CLAUDE_MODEL,
      },
      sessionId: "sess-1",
      persistedModels: new Map([["sess-1", "gpt-5.3-codex"]]),
      selectedModels: {},
      backends: [],
    });

    expect(model).toBe(DEFAULT_CLAUDE_MODEL);
  });
});
