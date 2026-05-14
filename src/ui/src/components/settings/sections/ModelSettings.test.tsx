// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig, ClaudeAuthStatus } from "../../../services/tauri";

const capabilities = {
  thinking: true,
  effort: true,
  fast_mode: true,
  one_m_context: false,
  tools: true,
  vision: false,
};

const appStore = vi.hoisted(() => ({
  alternativeBackendsEnabled: true,
  alternativeBackendsAvailable: true,
  setAlternativeBackendsEnabled: vi.fn(),
  experimentalCodexEnabled: true,
  setExperimentalCodexEnabled: vi.fn(),
  agentBackends: [] as AgentBackendConfig[],
  setAgentBackends: vi.fn((backends: AgentBackendConfig[]) => {
    appStore.agentBackends = backends;
  }),
  setDefaultAgentBackendId: vi.fn(),
  selectedModel: {} as Record<string, string>,
  selectedModelProvider: {} as Record<string, string>,
  setSelectedModel: vi.fn(),
  setSelectedModelProvider: vi.fn(),
  clearAgentQuestion: vi.fn(),
  clearPlanApproval: vi.fn(),
  clearAgentApproval: vi.fn(),
  settingsFocus: null as string | null,
  clearSettingsFocus: vi.fn(),
  claudeAuthFailure: null as { messageId: string | null; error: string } | null,
  setClaudeAuthFailure: vi.fn(),
  setResolvedClaudeAuthFailureMessageId: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  getAppSetting: vi.fn(() => Promise.resolve(null)),
  setAppSetting: vi.fn(() => Promise.resolve()),
  listAppSettingsWithPrefix: vi.fn(() => Promise.resolve([])),
  listAgentBackends: vi.fn(() =>
    Promise.resolve({
      backends: [] as AgentBackendConfig[],
      default_backend_id: "anthropic",
      warnings: [],
    }),
  ),
  saveAgentBackend: vi.fn((backend: AgentBackendConfig) =>
    Promise.resolve([backend]),
  ),
  saveAgentBackendSecret: vi.fn(() => Promise.resolve()),
  refreshAgentBackendModels: vi.fn(() => Promise.resolve([])),
  resetAgentSession: vi.fn(() => Promise.resolve()),
  testAgentBackend: vi.fn(() =>
    Promise.resolve({ ok: true, message: "OK", backends: [] }),
  ),
  launchCodexLogin: vi.fn(() => Promise.resolve()),
  getClaudeAuthStatus: vi.fn<() => Promise<ClaudeAuthStatus>>(() =>
    Promise.resolve({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    }),
  ),
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  submitClaudeAuthCode: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
}));

const eventMocks = vi.hoisted(() => ({
  listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ payload });
    }
  },
  reset() {
    this.listeners.clear();
  },
}));

vi.mock("../../../stores/useAppStore", () => {
  const useAppStore = <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore);
  useAppStore.getState = () => appStore;
  return { useAppStore };
});

vi.mock("../../../services/tauri", () => serviceMocks);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
    const listeners = eventMocks.listeners.get(event) ?? [];
    listeners.push(callback);
    eventMocks.listeners.set(event, listeners);
    return Promise.resolve(() => {
      const current = eventMocks.listeners.get(event) ?? [];
      eventMocks.listeners.set(
        event,
        current.filter((listener) => listener !== callback),
      );
    });
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ModelSettings } from "./ModelSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function backend(overrides: Partial<AgentBackendConfig>): AgentBackendConfig {
  return {
    id: "anthropic",
    label: "Claude Code",
    kind: "anthropic",
    base_url: null,
    enabled: true,
    default_model: "opus",
    manual_models: [],
    discovered_models: [],
    auth_ref: null,
    capabilities,
    context_window_default: 200_000,
    model_discovery: false,
    has_secret: false,
    ...overrides,
  };
}

async function renderModelSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<ModelSettings />);
  });
  return container;
}

describe("ModelSettings", () => {
  beforeEach(() => {
    appStore.alternativeBackendsEnabled = true;
    appStore.alternativeBackendsAvailable = true;
    appStore.experimentalCodexEnabled = true;
    appStore.agentBackends = [];
    appStore.settingsFocus = null;
    appStore.claudeAuthFailure = null;
    for (const value of Object.values(appStore)) {
      if (typeof value === "function" && "mockClear" in value) {
        value.mockClear();
      }
    }
    eventMocks.reset();
    serviceMocks.getAppSetting.mockReset();
    serviceMocks.getAppSetting.mockResolvedValue(null);
    serviceMocks.setAppSetting.mockClear();
    serviceMocks.listAppSettingsWithPrefix.mockClear();
    serviceMocks.listAgentBackends.mockReset();
    serviceMocks.listAgentBackends.mockResolvedValue({
      backends: [
        backend({ id: "anthropic", label: "Claude Code", kind: "anthropic" }),
        backend({
          id: "experimental-codex",
          label: "Codex",
          kind: "codex_native",
          default_model: "gpt-5.4",
        }),
      ],
      default_backend_id: "anthropic",
      warnings: [],
    });
    serviceMocks.getClaudeAuthStatus.mockReset();
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    });
    serviceMocks.claudeAuthLogin.mockClear();
    serviceMocks.submitClaudeAuthCode.mockClear();
    serviceMocks.cancelClaudeAuthLogin.mockClear();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0).reverse()) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove();
    }
  });

  it("checks Claude Code auth status from the Models provider section", async () => {
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_in",
      loggedIn: true,
      verified: false,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      message: null,
    });

    const container = await renderModelSettings();
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.getClaudeAuthStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("models_backends_title");
    expect(container.textContent).toContain("auth_setting_label");
    expect(container.textContent).toContain("auth_status_signed_in");
  });

  it("keeps the Claude Code browser-code sign-in flow working from Models", async () => {
    const container = await renderModelSettings();
    await act(async () => {
      await Promise.resolve();
    });

    const signIn = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("auth_sign_in"),
    );
    expect(signIn).not.toBeUndefined();
    await act(async () => {
      signIn?.click();
      await Promise.resolve();
    });
    await act(async () => {
      eventMocks.emit("auth://login-progress", {
        stream: "stdout",
        line: "If the browser didn't open, visit: https://claude.ai/auth/code",
      });
      await Promise.resolve();
    });

    const codeInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="auth_code_placeholder"]',
    );
    expect(codeInput).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        codeInput,
        "  abc-123  ",
      );
      codeInput!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const submit = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("auth_submit_code"),
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await Promise.resolve();
    });

    expect(serviceMocks.claudeAuthLogin).toHaveBeenCalledTimes(1);
    expect(serviceMocks.submitClaudeAuthCode).toHaveBeenCalledWith("abc-123");
  });

  it("surfaces chat auth failures in the Models Claude Code provider row", async () => {
    appStore.claudeAuthFailure = {
      messageId: "assistant-1",
      error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    };
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_in",
      loggedIn: true,
      verified: false,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      message: null,
    });

    const container = await renderModelSettings();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("auth_status_last_failure");
    expect(container.textContent).toContain(
      "Invalid authentication credentials (401)",
    );
    expect(container.textContent).not.toContain("auth_status_signed_in");
  });

  it("does not persist unknown auth validation results as chat auth failures", async () => {
    serviceMocks.getClaudeAuthStatus
      .mockResolvedValueOnce({
        state: "signed_in",
        loggedIn: true,
        verified: false,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        message: null,
      })
      .mockResolvedValueOnce({
        state: "unknown",
        loggedIn: true,
        verified: false,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        message: "Claude Code auth validation timed out.",
      });

    const container = await renderModelSettings();
    await act(async () => {
      await Promise.resolve();
    });

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="auth_refresh_status"]',
    );
    expect(refresh).not.toBeNull();
    await act(async () => {
      refresh?.click();
      await Promise.resolve();
    });

    expect(serviceMocks.getClaudeAuthStatus).toHaveBeenCalledTimes(2);
    expect(serviceMocks.getClaudeAuthStatus).toHaveBeenLastCalledWith(true);
    expect(appStore.setClaudeAuthFailure).not.toHaveBeenCalled();
  });

  it("does not resolve a chat auth failure until sign-in validates", async () => {
    appStore.claudeAuthFailure = {
      messageId: "assistant-1",
      error: "Not logged in · Please run /login",
    };
    serviceMocks.getClaudeAuthStatus
      .mockResolvedValueOnce({
        state: "signed_in",
        loggedIn: true,
        verified: false,
        authMethod: "oauth_token",
        apiProvider: "firstParty",
        message: null,
      })
      .mockResolvedValueOnce({
        state: "signed_out",
        loggedIn: false,
        verified: false,
        authMethod: null,
        apiProvider: null,
        message: "Not logged in · Please run /login",
      });

    const container = await renderModelSettings();
    await act(async () => {
      await Promise.resolve();
    });

    const signIn = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("auth_reauthenticate"),
    );
    expect(signIn).not.toBeUndefined();
    await act(async () => {
      signIn?.click();
      await Promise.resolve();
    });
    await act(async () => {
      eventMocks.emit("auth://login-complete", { success: true, error: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(serviceMocks.getClaudeAuthStatus).toHaveBeenLastCalledWith(true);
    expect(appStore.setResolvedClaudeAuthFailureMessageId).not.toHaveBeenCalledWith(
      "assistant-1",
    );
    expect(appStore.setResolvedClaudeAuthFailureMessageId).toHaveBeenCalledWith(null);
    expect(appStore.setClaudeAuthFailure).toHaveBeenCalledWith({
      messageId: "assistant-1",
      error: "Not logged in · Please run /login",
    });
  });
});
