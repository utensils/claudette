import { describe, expect, it } from "vitest";
import {
  LEGACY_CODEX_BACKEND,
  NATIVE_CODEX_BACKEND,
  planCodexBackendGateMigration,
} from "./codexBackendMigration";

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
