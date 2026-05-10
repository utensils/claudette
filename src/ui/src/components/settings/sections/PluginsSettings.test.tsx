// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudettePluginInfo } from "../../../types/claudettePlugins";
import type { VoiceProviderInfo } from "../../../types/voice";

const claudettePluginServices = vi.hoisted(() => ({
  listBuiltinClaudettePlugins: vi.fn(),
  listClaudettePlugins: vi.fn(),
  reseedBundledPlugins: vi.fn(),
  setBuiltinClaudettePluginEnabled: vi.fn(),
  setClaudettePluginEnabled: vi.fn(),
  setClaudettePluginSetting: vi.fn(),
}));

const voiceServices = vi.hoisted(() => ({
  listVoiceProviders: vi.fn(),
  prepareVoiceProvider: vi.fn(),
  removeVoiceProviderModel: vi.fn(),
  setSelectedVoiceProvider: vi.fn(),
  setVoiceProviderEnabled: vi.fn(),
}));

const grammarServices = vi.hoisted(() => ({
  listLanguageGrammars: vi.fn(),
}));

const store = vi.hoisted(() => ({
  focusVoiceProvider: vi.fn(),
  voiceProviderFocus: null as string | null,
}));

vi.mock("../../../services/claudettePlugins", () => claudettePluginServices);

vi.mock("../../../services/voice", () => voiceServices);

vi.mock("../../../services/grammars", () => grammarServices);

vi.mock("../../../utils/grammarRegistry", () => ({
  refreshGrammars: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof store) => T): T => selector(store),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.error ? `${key}: ${values.error}` : key,
  }),
}));

import { PluginsSettings } from "./PluginsSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function luaPlugin(overrides: Partial<ClaudettePluginInfo> = {}): ClaudettePluginInfo {
  return {
    name: "scm-github",
    display_name: "GitHub",
    version: "1.0.0",
    description: "GitHub provider",
    kind: "scm",
    required_clis: [],
    cli_available: true,
    enabled: true,
    settings_schema: [],
    setting_values: {},
    ...overrides,
  };
}

function voiceProvider(overrides: Partial<VoiceProviderInfo> = {}): VoiceProviderInfo {
  return {
    id: "apple-speech",
    name: "Apple Speech",
    description: "Native speech recognition",
    kind: "platform",
    recordingMode: "native",
    privacyLabel: "Uses system speech recognition",
    offline: false,
    downloadRequired: false,
    modelSizeLabel: null,
    cachePath: null,
    acceleratorLabel: null,
    status: "ready",
    statusLabel: "ready",
    enabled: true,
    selected: true,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...overrides,
  };
}

async function renderPluginsSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<PluginsSettings />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("PluginsSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    store.voiceProviderFocus = null;
    store.focusVoiceProvider.mockReset();
    Object.values(claudettePluginServices).forEach((mock) => mock.mockReset());
    Object.values(voiceServices).forEach((mock) => mock.mockReset());
    grammarServices.listLanguageGrammars.mockReset();

    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      luaPlugin(),
    ]);
    claudettePluginServices.listBuiltinClaudettePlugins.mockResolvedValue([
      {
        name: "send_to_user",
        title: "Send file to user",
        description: "Deliver files inline",
        enabled: true,
      },
    ]);
    voiceServices.listVoiceProviders.mockResolvedValue([voiceProvider()]);
    grammarServices.listLanguageGrammars.mockResolvedValue({
      languages: [],
      grammars: [],
    });
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

  it("keeps other plugin groups visible when voice providers fail to load", async () => {
    voiceServices.listVoiceProviders.mockRejectedValueOnce(
      "voice support not built into this binary",
    );

    const container = await renderPluginsSettings();

    expect(container.textContent).toContain("Send file to user");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("plugins_voice_label");
    expect(container.textContent).toContain(
      "plugins_group_load_error: voice support not built into this binary",
    );
    expect(container.textContent).not.toContain("plugins_load_error");
  });

  it("keeps voice and Lua plugins visible when built-ins fail to load", async () => {
    claudettePluginServices.listBuiltinClaudettePlugins.mockRejectedValueOnce(
      new Error("database is locked"),
    );

    const container = await renderPluginsSettings();

    expect(container.textContent).toContain("Apple Speech");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("plugins_builtins_label");
    expect(container.textContent).toContain(
      "plugins_group_load_error: database is locked",
    );
  });
});
