import { describe, expect, it } from "vitest";
import {
  LEGACY_CODEX_BACKEND,
  NATIVE_CODEX_BACKEND,
  planCodexBackendGateMigration,
  planExperimentalBackendGateLoad,
  shouldEnableAlternativeBackendsForCodex,
} from "./codexBackendMigration";

describe("planExperimentalBackendGateLoad", () => {
  it("enables alternative backends by default when the build includes them", () => {
    const plan = planExperimentalBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: null,
      experimentalCodexSetting: null,
    });

    expect(plan.alternativeBackendsEnabled).toBe(true);
    expect(plan.experimentalCodexEnabled).toBe(false);
    expect(plan.persistAlternativeBackendsEnabled).toBe(false);
  });

  it("keeps alternative backends off when explicitly disabled", () => {
    const plan = planExperimentalBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: "false",
      experimentalCodexSetting: null,
    });

    expect(plan.alternativeBackendsEnabled).toBe(false);
    expect(plan.experimentalCodexEnabled).toBe(false);
  });

  it("lets Experimental Codex repair an explicitly disabled alternative gate", () => {
    const plan = planExperimentalBackendGateLoad({
      alternativeBackendsCompiled: true,
      alternativeBackendsSetting: "false",
      experimentalCodexSetting: "true",
    });

    expect(plan.alternativeBackendsEnabled).toBe(true);
    expect(plan.experimentalCodexEnabled).toBe(true);
    expect(plan.persistAlternativeBackendsEnabled).toBe(true);
  });

  it("keeps both gates off when the build omits alternative backend support", () => {
    const plan = planExperimentalBackendGateLoad({
      alternativeBackendsCompiled: false,
      alternativeBackendsSetting: "true",
      experimentalCodexSetting: "true",
    });

    expect(plan.alternativeBackendsEnabled).toBe(false);
    expect(plan.experimentalCodexEnabled).toBe(false);
  });
});

describe("shouldEnableAlternativeBackendsForCodex", () => {
  it("only enables the parent gate when turning Experimental Codex on", () => {
    expect(shouldEnableAlternativeBackendsForCodex(true, false)).toBe(true);
    expect(shouldEnableAlternativeBackendsForCodex(true, true)).toBe(false);
    expect(shouldEnableAlternativeBackendsForCodex(false, false)).toBe(false);
  });
});

describe("planCodexBackendGateMigration", () => {
  it("maps legacy Codex defaults and sessions to native Codex when enabled", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: true,
      defaultBackend: LEGACY_CODEX_BACKEND,
      sessionProviders: [["model_provider:sess-1", LEGACY_CODEX_BACKEND]],
      selectedProviders: { "sess-2": LEGACY_CODEX_BACKEND },
    });

    expect(plan).toEqual({
      fromBackend: LEGACY_CODEX_BACKEND,
      toBackend: NATIVE_CODEX_BACKEND,
      defaultBackend: NATIVE_CODEX_BACKEND,
      resetDefault: true,
      sessionIds: ["sess-1", "sess-2"],
    });
  });

  it("maps native Codex defaults and sessions back to legacy Codex when disabled", () => {
    const plan = planCodexBackendGateMigration({
      enableNative: false,
      defaultBackend: NATIVE_CODEX_BACKEND,
      sessionProviders: [["model_provider:sess-1", NATIVE_CODEX_BACKEND]],
      selectedProviders: { "sess-2": NATIVE_CODEX_BACKEND },
    });

    expect(plan.defaultBackend).toBe(LEGACY_CODEX_BACKEND);
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
