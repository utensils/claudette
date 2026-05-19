// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockState {
  selectedModel: Record<string, string>;
  selectedModelProvider: Record<string, string>;
  disable1mContext: boolean;
  planMode: Record<string, boolean>;
  modelSelectorOpen: boolean;
  keybindings: Record<string, unknown>;
  claudeFlagsByWorkspace: Record<string, { resolved: string[] } | undefined>;
  setSelectedModel: ReturnType<typeof vi.fn>;
  setFastMode: ReturnType<typeof vi.fn>;
  setThinkingEnabled: ReturnType<typeof vi.fn>;
  setPlanMode: ReturnType<typeof vi.fn>;
  setEffortLevel: ReturnType<typeof vi.fn>;
  setChromeEnabled: ReturnType<typeof vi.fn>;
  setShowThinkingBlocks: ReturnType<typeof vi.fn>;
  setModelSelectorOpen: ReturnType<typeof vi.fn>;
  loadWorkspaceClaudeFlags: ReturnType<typeof vi.fn>;
}

const appStore = vi.hoisted(
  () =>
    ({
      selectedModel: { s1: "opus" },
      selectedModelProvider: { s1: "anthropic" },
      disable1mContext: false,
      planMode: { s1: false },
      modelSelectorOpen: false,
      keybindings: {},
      claudeFlagsByWorkspace: { w1: { resolved: [] } },
      setSelectedModel: vi.fn(),
      setFastMode: vi.fn(),
      setThinkingEnabled: vi.fn(),
      setPlanMode: vi.fn(),
      setEffortLevel: vi.fn(),
      setChromeEnabled: vi.fn(),
      setShowThinkingBlocks: vi.fn(),
      setModelSelectorOpen: vi.fn(),
      loadWorkspaceClaudeFlags: vi.fn(),
    }) satisfies MockState as MockState,
);

const serviceMocks = vi.hoisted(() => ({
  getAppSetting: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: MockState) => T): T => selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  getAppSetting: serviceMocks.getAppSetting,
}));

vi.mock("../useModelRegistry", () => ({
  useModelRegistry: () => [
    {
      id: "opus",
      providerId: "anthropic",
      label: "Opus",
      supportsFastMode: false,
      supportsEffort: true,
    },
  ],
}));

vi.mock("../ModelSelector", async () => {
  const actual =
    await vi.importActual<typeof import("../ModelSelector")>("../ModelSelector");
  return {
    ...actual,
    ModelSelector: () => <div data-testid="model-selector" />,
  };
});

vi.mock("../applySelectedModel", () => ({
  applySelectedModel: vi.fn(() => Promise.resolve()),
}));

vi.mock("../applyPlanModeMountDefault", () => ({
  applyPlanModeMountDefault: vi.fn(),
}));

vi.mock("./ReasoningPill", () => ({
  ReasoningPill: ({ disabled }: { disabled: boolean }) => (
    <button type="button" disabled={disabled} data-testid="reasoning-pill">
      Thinking
    </button>
  ),
}));

vi.mock("./OverflowMenu", () => ({
  OverflowMenu: ({
    configDisabled,
    sendDisabled,
  }: {
    configDisabled: boolean;
    sendDisabled: boolean;
  }) => (
    <button
      type="button"
      disabled={configDisabled}
      data-send-disabled={String(sendDisabled)}
      data-testid="overflow-menu"
    >
      More options
    </button>
  ),
}));

import { ComposerToolbar } from "./ComposerToolbar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderToolbar(props: {
  configDisabled?: boolean;
  sendDisabled?: boolean;
  isRunning?: boolean;
}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);

  await act(async () => {
    root.render(
      <ComposerToolbar
        sessionId="s1"
        workspaceId="w1"
        repoId="r1"
        configDisabled={props.configDisabled ?? false}
        sendDisabled={props.sendDisabled ?? false}
        isRunning={props.isRunning ?? false}
        isRemote={false}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button "${text}" not found`);
  return button;
}

beforeEach(() => {
  serviceMocks.getAppSetting.mockClear();
  appStore.setSelectedModel.mockClear();
  appStore.setPlanMode.mockClear();
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

describe("ComposerToolbar disable semantics", () => {
  it("keeps config controls enabled when only sending is blocked", async () => {
    const { container } = await renderToolbar({ sendDisabled: true });

    expect(buttonByText(container, "Opus").disabled).toBe(false);
    expect(buttonByText(container, "Plan").disabled).toBe(false);
    expect(buttonByText(container, "Thinking").disabled).toBe(false);
    expect(buttonByText(container, "More options").disabled).toBe(false);
    expect(
      buttonByText(container, "More options").dataset.sendDisabled,
    ).toBe("true");
  });

  it("locks config controls when configuration changes are blocked", async () => {
    const { container } = await renderToolbar({ configDisabled: true });

    expect(buttonByText(container, "Opus").disabled).toBe(true);
    expect(buttonByText(container, "Plan").disabled).toBe(true);
    expect(buttonByText(container, "Thinking").disabled).toBe(true);
    expect(buttonByText(container, "More options").disabled).toBe(true);
  });

  it("keeps running-turn session mutations locked", async () => {
    const { container } = await renderToolbar({ isRunning: true });

    expect(buttonByText(container, "Opus").disabled).toBe(true);
    expect(buttonByText(container, "Plan").disabled).toBe(true);
    expect(buttonByText(container, "Thinking").disabled).toBe(true);
  });
});
