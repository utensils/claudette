// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig } from "../../services/tauri";

const appStore = vi.hoisted(() => ({
  selectedModel: {} as Record<string, string>,
  selectedModelProvider: {} as Record<string, string>,
  setSelectedModel: vi.fn((sid: string, model: string, provider?: string) => {
    appStore.selectedModel[sid] = model;
    if (provider) appStore.selectedModelProvider[sid] = provider;
  }),
  disable1mContext: false,
  fastMode: {} as Record<string, boolean>,
  setFastMode: vi.fn((sid: string, v: boolean) => {
    appStore.fastMode[sid] = v;
  }),
  effortLevel: {} as Record<string, string>,
  setEffortLevel: vi.fn((sid: string, v: string) => {
    appStore.effortLevel[sid] = v;
  }),
  clearAgentQuestion: vi.fn(),
  clearPlanApproval: vi.fn(),
  clearAgentApproval: vi.fn(),
  claudeAuthMethod: null as string | null,
  alternativeBackendsEnabled: true,
  agentBackends: [] as AgentBackendConfig[],
  codexEnabled: true,
  piSdkAvailable: true,
  pushToast: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  resetAgentSession: vi.fn(() => Promise.resolve()),
  setAppSetting: vi.fn(() => Promise.resolve()),
  prepareCrossHarnessMigration: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../stores/useAppStore", () => {
  const useAppStore = <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore);
  useAppStore.getState = () => appStore;
  return { useAppStore };
});

vi.mock("../../services/tauri", () => serviceMocks);

// applySelectedModel is imported AFTER the mocks so its module-scope
// `import` of useAppStore + services/tauri picks up the stubs.
const { applySelectedModel } = await import("./applySelectedModel");

function backend(
  id: string,
  kind: AgentBackendConfig["kind"],
  models: { id: string; label?: string; ctx?: number }[] = [],
  overrides: Partial<AgentBackendConfig> = {},
): AgentBackendConfig {
  return {
    id,
    label: id,
    kind,
    enabled: true,
    base_url: "",
    default_model: null,
    model_discovery: "manual",
    manual_models: models.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      context_window_tokens: m.ctx ?? 200_000,
    })),
    discovered_models: [],
    capabilities: { thinking: false, effort: false, fast_mode: false },
    runtime_harness: null,
    ...overrides,
  } as unknown as AgentBackendConfig;
}

function resetState() {
  appStore.selectedModel = {};
  appStore.selectedModelProvider = {};
  appStore.disable1mContext = false;
  appStore.fastMode = {};
  appStore.effortLevel = {};
  appStore.claudeAuthMethod = null;
  appStore.alternativeBackendsEnabled = true;
  appStore.agentBackends = [];
  appStore.codexEnabled = true;
  appStore.piSdkAvailable = true;
  appStore.setSelectedModel.mockClear();
  appStore.setFastMode.mockClear();
  appStore.setEffortLevel.mockClear();
  appStore.clearAgentQuestion.mockClear();
  appStore.clearPlanApproval.mockClear();
  appStore.clearAgentApproval.mockClear();
  appStore.pushToast.mockClear();
  serviceMocks.resetAgentSession.mockClear();
  serviceMocks.setAppSetting.mockClear();
  serviceMocks.prepareCrossHarnessMigration.mockClear();
  serviceMocks.prepareCrossHarnessMigration.mockImplementation(() => Promise.resolve());
}

beforeEach(() => resetState());
afterEach(() => resetState());

describe("applySelectedModel", () => {
  describe("same-harness model swap", () => {
    it("does NOT call resetAgentSession when switching Sonnet 4.6 -> Opus 4.7 (both Claude Code)", async () => {
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "claude-opus-4-7", "anthropic");

      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
      expect(appStore.setSelectedModel).toHaveBeenCalledWith(
        "sess-1",
        "claude-opus-4-7",
        "anthropic",
      );
      expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
        "model:sess-1",
        "claude-opus-4-7",
      );
      expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
        "model_provider:sess-1",
        "anthropic",
      );
    });

    it("does NOT call resetAgentSession swapping between Pi-routed sibling models", async () => {
      appStore.agentBackends = [
        backend("pi-sdk", "pi_sdk", [
          { id: "ollama/llama3", label: "llama3" },
          { id: "ollama/qwen3", label: "qwen3" },
        ]),
      ];
      appStore.selectedModel["sess-1"] = "ollama/llama3";
      appStore.selectedModelProvider["sess-1"] = "pi-sdk";

      await applySelectedModel("sess-1", "ollama/qwen3", "pi-sdk");

      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });

    it("does NOT call resetAgentSession when the swap is a no-op (same model + provider)", async () => {
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "sonnet", "anthropic");

      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });
  });

  describe("cross-harness model swap", () => {
    it("prepares cross-harness migration when crossing from Claude Code -> Codex app server", async () => {
      appStore.agentBackends = [
        backend("codex-native", "codex_native", [
          { id: "gpt-5.4", label: "gpt-5.4" },
        ]),
      ];
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "gpt-5.4", "codex-native");

      // Migration takes precedence: it preserves the prior conversation
      // as a synthetic prelude on the new harness, instead of wiping.
      expect(serviceMocks.prepareCrossHarnessMigration).toHaveBeenCalledWith("sess-1");
      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });

    it("prepares cross-harness migration when crossing from Claude Code -> Pi", async () => {
      appStore.agentBackends = [
        backend("pi-sdk", "pi_sdk", [
          { id: "ollama/llama3", label: "llama3" },
        ]),
      ];
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "ollama/llama3", "pi-sdk");

      expect(serviceMocks.prepareCrossHarnessMigration).toHaveBeenCalledWith("sess-1");
      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });

    it("falls back to resetAgentSession when prepareCrossHarnessMigration throws", async () => {
      // The Rust command can fail (missing chat session row, DB
      // error). When that happens, the next-best behaviour is a
      // hard reset — strictly better than leaving the session in
      // an inconsistent state where the harness changed but the
      // prior session_id is still on the row.
      serviceMocks.prepareCrossHarnessMigration.mockImplementationOnce(() =>
        Promise.reject(new Error("Chat session not found")),
      );
      appStore.agentBackends = [
        backend("codex-native", "codex_native", [
          { id: "gpt-5.4", label: "gpt-5.4" },
        ]),
      ];
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "gpt-5.4", "codex-native");

      expect(serviceMocks.prepareCrossHarnessMigration).toHaveBeenCalledWith("sess-1");
      expect(serviceMocks.resetAgentSession).toHaveBeenCalledWith("sess-1");
    });
  });

  describe("first-time selection (no previous model)", () => {
    it("does NOT call resetAgentSession when there is no prior selection", async () => {
      // Empty store: no prior selection means no transcript to lose.
      await applySelectedModel("sess-1", "claude-opus-4-7", "anthropic");
      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });
  });

  describe("1M-context fallback", () => {
    it("substitutes the non-1M fallback when disable1mContext is true (still same-harness, no reset)", async () => {
      appStore.disable1mContext = true;
      appStore.selectedModel["sess-1"] = "claude-opus-4-7";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "opus", "anthropic");

      expect(appStore.setSelectedModel).toHaveBeenCalledWith(
        "sess-1",
        "claude-opus-4-7",
        "anthropic",
      );
      expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
    });
  });

  describe("clears stale per-session UI state on every swap", () => {
    it("clears pending question/plan/approval state regardless of harness", async () => {
      appStore.selectedModel["sess-1"] = "sonnet";
      appStore.selectedModelProvider["sess-1"] = "anthropic";

      await applySelectedModel("sess-1", "claude-opus-4-7", "anthropic");

      expect(appStore.clearAgentQuestion).toHaveBeenCalledWith("sess-1");
      expect(appStore.clearPlanApproval).toHaveBeenCalledWith("sess-1");
      expect(appStore.clearAgentApproval).toHaveBeenCalledWith("sess-1");
    });
  });
});
