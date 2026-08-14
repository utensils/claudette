// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig, PinnedPrompt } from "../../services/tauri";

const appStore = vi.hoisted(() => ({
  // Model-registry inputs (read by resolvePinnedPromptModel + applySelectedModel).
  alternativeBackendsEnabled: true,
  codexEnabled: true,
  agentBackends: [] as AgentBackendConfig[],
  disable1mContext: false,

  // Per-session toolbar state.
  selectedModel: {} as Record<string, string>,
  selectedModelProvider: {} as Record<string, string>,
  fastMode: {} as Record<string, boolean>,
  thinkingEnabled: {} as Record<string, boolean>,
  chromeEnabled: {} as Record<string, boolean>,
  planMode: {} as Record<string, boolean>,
  effortLevel: {} as Record<string, string>,

  setSelectedModel: vi.fn((sid: string, model: string, provider?: string) => {
    appStore.selectedModel[sid] = model;
    if (provider) appStore.selectedModelProvider[sid] = provider;
  }),
  setFastMode: vi.fn((sid: string, v: boolean) => {
    appStore.fastMode[sid] = v;
  }),
  setThinkingEnabled: vi.fn((sid: string, v: boolean) => {
    appStore.thinkingEnabled[sid] = v;
  }),
  setChromeEnabled: vi.fn((sid: string, v: boolean) => {
    appStore.chromeEnabled[sid] = v;
  }),
  setEffortLevel: vi.fn((sid: string, v: string) => {
    appStore.effortLevel[sid] = v;
  }),
  clearAgentQuestion: vi.fn(),
  clearPlanApproval: vi.fn(),
  clearAgentApproval: vi.fn(),

  addChatSession: vi.fn(),
  clearActiveFileTab: vi.fn(),
  selectSession: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  renameChatSession: vi.fn(() => Promise.resolve()),
  setAppSetting: vi.fn((_key: string, _value: string) => Promise.resolve()),
  resetAgentSession: vi.fn(() => Promise.resolve()),
  prepareCrossHarnessMigration: vi.fn(() => Promise.resolve()),
}));

const planModeMocks = vi.hoisted(() => ({
  setPlanModeAndPersist: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../stores/useAppStore", () => {
  const useAppStore = <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore);
  useAppStore.getState = () => appStore;
  return { useAppStore };
});

vi.mock("../../services/tauri", () => serviceMocks);
vi.mock("./planModePersistence", () => planModeMocks);

// Imported after the mocks so the module-scope bindings pick up the stubs.
const { preparePinnedPromptTarget, resolvePinnedPromptModel } = await import(
  "./pinnedPromptLaunch"
);

function pin(overrides: Partial<PinnedPrompt> = {}): PinnedPrompt {
  return {
    id: 1,
    repo_id: null,
    display_name: "Review",
    prompt: "/review",
    auto_send: true,
    plan_mode: null,
    fast_mode: null,
    thinking_enabled: null,
    chrome_enabled: null,
    new_session: false,
    model: null,
    model_provider: null,
    sort_order: 0,
    created_at: "",
    ...overrides,
  };
}

function backend(
  id: string,
  kind: string,
  models: string[],
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
      id: m,
      label: m,
      context_window_tokens: 200_000,
    })),
    discovered_models: [],
    capabilities: { thinking: true, effort: true, fast_mode: false },
    runtime_harness: null,
  } as unknown as AgentBackendConfig;
}

function session(id: string) {
  return {
    id,
    workspace_id: "ws-1",
    session_id: null,
    name: "New chat",
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
  };
}

const CTX = { workspaceId: "ws-1", sessionId: "sess-current" };

beforeEach(() => {
  appStore.alternativeBackendsEnabled = true;
  appStore.codexEnabled = true;
  appStore.agentBackends = [];
  appStore.selectedModel = {};
  appStore.selectedModelProvider = {};
  appStore.fastMode = {};
  appStore.thinkingEnabled = {};
  appStore.chromeEnabled = {};
  appStore.planMode = {};
  appStore.effortLevel = {};
  vi.clearAllMocks();
  serviceMocks.createChatSession.mockImplementation(() =>
    Promise.resolve(session("sess-new")),
  );
  serviceMocks.renameChatSession.mockImplementation(() => Promise.resolve());
  serviceMocks.setAppSetting.mockImplementation(() => Promise.resolve());
});

describe("resolvePinnedPromptModel", () => {
  it("returns null when the pin doesn't name a model", () => {
    expect(resolvePinnedPromptModel(pin())).toBeNull();
  });

  it("resolves a curated Claude Code model", () => {
    expect(
      resolvePinnedPromptModel(pin({ model: "opus", model_provider: "anthropic" })),
    ).toEqual({ model: "opus", provider: "anthropic" });
  });

  it("resolves a backend model against its provider", () => {
    appStore.agentBackends = [backend("codex-native", "codex_native", ["gpt-5.5"])];
    expect(
      resolvePinnedPromptModel(
        pin({ model: "gpt-5.5", model_provider: "codex-native" }),
      ),
    ).toEqual({ model: "gpt-5.5", provider: "codex-native" });
  });

  it("returns null when the model's backend is no longer exposed", () => {
    // Backend exists but the alt-backends gate is off, so the registry
    // never surfaces its models.
    appStore.agentBackends = [backend("ollama", "ollama", ["qwen3-coder"])];
    appStore.alternativeBackendsEnabled = false;
    expect(
      resolvePinnedPromptModel(
        pin({ model: "qwen3-coder", model_provider: "ollama" }),
      ),
    ).toBeNull();
  });
});

describe("preparePinnedPromptTarget — active session", () => {
  it("applies forced toggles in place and reports no new session", async () => {
    const result = await preparePinnedPromptTarget(
      pin({ fast_mode: true, thinking_enabled: false, plan_mode: true }),
      CTX,
    );

    expect(result).toEqual({ sessionId: "sess-current", openedNewSession: false });
    expect(appStore.setFastMode).toHaveBeenCalledWith("sess-current", true);
    expect(appStore.setThinkingEnabled).toHaveBeenCalledWith("sess-current", false);
    expect(planModeMocks.setPlanModeAndPersist).toHaveBeenCalledWith(
      "sess-current",
      true,
    );
    expect(serviceMocks.createChatSession).not.toHaveBeenCalled();
  });

  it("leaves null overrides alone so the session's own values survive", async () => {
    await preparePinnedPromptTarget(pin({ fast_mode: true }), CTX);

    expect(appStore.setThinkingEnabled).not.toHaveBeenCalled();
    expect(appStore.setChromeEnabled).not.toHaveBeenCalled();
    expect(planModeMocks.setPlanModeAndPersist).not.toHaveBeenCalled();
  });

  it("switches the active session's model when the pin names one", async () => {
    await preparePinnedPromptTarget(pin({ model: "sonnet", model_provider: "anthropic" }), CTX);

    expect(appStore.setSelectedModel).toHaveBeenCalledWith(
      "sess-current",
      "sonnet",
      "anthropic",
    );
  });

  it("falls back to the session's model when the pin's model is gone", async () => {
    await preparePinnedPromptTarget(
      pin({ model: "qwen3-coder", model_provider: "ollama" }),
      CTX,
    );

    expect(appStore.setSelectedModel).not.toHaveBeenCalled();
  });

  it("throws when the model swap fails, so the caller skips the send", async () => {
    // Deliberately fatal here: nothing has been committed, so there's no
    // orphan to strand, and a half-applied swap isn't a state to send a
    // turn on. Contrast with the new-session path, which degrades.
    serviceMocks.setAppSetting.mockImplementation((key: string) =>
      key.startsWith("model:")
        ? Promise.reject(new Error("db locked"))
        : Promise.resolve(),
    );

    await expect(
      preparePinnedPromptTarget(
        pin({ model: "sonnet", model_provider: "anthropic" }),
        CTX,
      ),
    ).rejects.toThrow("db locked");
  });
});

describe("preparePinnedPromptTarget — new session", () => {
  it("creates, names, and selects a tab, and targets it", async () => {
    const result = await preparePinnedPromptTarget(
      pin({ new_session: true, display_name: "Codex review" }),
      CTX,
    );

    expect(result).toEqual({ sessionId: "sess-new", openedNewSession: true });
    expect(serviceMocks.createChatSession).toHaveBeenCalledWith("ws-1");
    expect(serviceMocks.renameChatSession).toHaveBeenCalledWith(
      "sess-new",
      "Codex review",
    );
    expect(appStore.addChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sess-new",
        name: "Codex review",
        name_edited: true,
      }),
    );
    expect(appStore.clearActiveFileTab).toHaveBeenCalledWith("ws-1");
    expect(appStore.selectSession).toHaveBeenCalledWith("ws-1", "sess-new");
  });

  it("persists forced toggles so the composer's mount-load can't clobber them", async () => {
    // ComposerToolbar re-reads these app settings whenever its sessionId
    // changes and writes them into the store unconditionally. A store-only
    // write here would be silently overwritten a tick later, which is the
    // whole reason this path persists.
    await preparePinnedPromptTarget(
      pin({ new_session: true, fast_mode: true, chrome_enabled: false }),
      CTX,
    );

    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "fast_mode:sess-new",
      "true",
    );
    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "chrome_enabled:sess-new",
      "false",
    );
    // Untouched toggles stay unwritten so the new tab keeps its defaults.
    expect(serviceMocks.setAppSetting).not.toHaveBeenCalledWith(
      "thinking_enabled:sess-new",
      expect.anything(),
    );
  });

  it("persists plan mode exactly once", async () => {
    // `persistToggleOverrides` used to write plan_mode too, duplicating the
    // write that `applyToggleOverridesToStore` already performs.
    await preparePinnedPromptTarget(
      pin({ new_session: true, plan_mode: true }),
      CTX,
    );

    expect(planModeMocks.setPlanModeAndPersist).toHaveBeenCalledTimes(1);
    expect(planModeMocks.setPlanModeAndPersist).toHaveBeenCalledWith(
      "sess-new",
      true,
    );
  });

  it("still opens the tab when a toggle fails to persist", async () => {
    // Persistence runs after createChatSession has already committed a row,
    // so a rejected write must not abort the launch — that would strand a
    // session that exists in the DB but was never named, added, or selected.
    serviceMocks.setAppSetting.mockImplementation((key: string) =>
      key.startsWith("fast_mode:")
        ? Promise.reject(new Error("db locked"))
        : Promise.resolve(),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await preparePinnedPromptTarget(
      pin({ new_session: true, fast_mode: true }),
      CTX,
    );

    expect(result).toEqual({ sessionId: "sess-new", openedNewSession: true });
    expect(appStore.selectSession).toHaveBeenCalledWith("ws-1", "sess-new");
    consoleError.mockRestore();
  });

  it("still opens the tab when the model fails to apply", async () => {
    // Same reasoning as the toggle-persist case: the session row is already
    // committed, so a rejected write inside applySelectedModel must not
    // abandon a tab that exists in the DB but was never named, added, or
    // selected. The tab opens on its default model instead.
    serviceMocks.setAppSetting.mockImplementation((key: string) =>
      key.startsWith("model:")
        ? Promise.reject(new Error("db locked"))
        : Promise.resolve(),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await preparePinnedPromptTarget(
      pin({ new_session: true, model: "sonnet", model_provider: "anthropic" }),
      CTX,
    );

    expect(result).toEqual({ sessionId: "sess-new", openedNewSession: true });
    expect(serviceMocks.renameChatSession).toHaveBeenCalledWith(
      "sess-new",
      "Review",
    );
    expect(appStore.selectSession).toHaveBeenCalledWith("ws-1", "sess-new");
    consoleError.mockRestore();
  });

  it("selects the pin's model on the new tab without a cross-harness reset", async () => {
    appStore.agentBackends = [backend("codex-native", "codex_native", ["gpt-5.5"])];

    await preparePinnedPromptTarget(
      pin({ new_session: true, model: "gpt-5.5", model_provider: "codex-native" }),
      CTX,
    );

    expect(appStore.setSelectedModel).toHaveBeenCalledWith(
      "sess-new",
      "gpt-5.5",
      "codex-native",
    );
    // A brand-new session has no prior model, so this is a first-time
    // selection — no migration prelude, no agent reset.
    expect(serviceMocks.prepareCrossHarnessMigration).not.toHaveBeenCalled();
    expect(serviceMocks.resetAgentSession).not.toHaveBeenCalled();
  });

  it("still opens the tab when naming it fails", async () => {
    serviceMocks.renameChatSession.mockImplementation(() =>
      Promise.reject(new Error("nope")),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await preparePinnedPromptTarget(pin({ new_session: true }), CTX);

    expect(result.openedNewSession).toBe(true);
    expect(appStore.addChatSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New chat", name_edited: false }),
    );
    expect(appStore.selectSession).toHaveBeenCalledWith("ws-1", "sess-new");
    consoleError.mockRestore();
  });

  it("propagates a failed session creation instead of half-launching", async () => {
    serviceMocks.createChatSession.mockImplementation(() =>
      Promise.reject(new Error("db locked")),
    );

    await expect(
      preparePinnedPromptTarget(pin({ new_session: true }), CTX),
    ).rejects.toThrow("db locked");
    expect(appStore.selectSession).not.toHaveBeenCalled();
  });
});
