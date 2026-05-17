// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentBackendConfig,
  AgentBackendKind,
} from "../../../services/tauri/agentBackends";
import type { UsageSnapshot } from "../../../types/usage";

// Hoisted store state — selectors run against this object via the
// useAppStore mock below.
const appStore = vi.hoisted(() => ({
  usageInsightsEnabled: false,
  agentBackends: [] as AgentBackendConfig[],
  selectedModelProvider: {} as Record<string, string>,
  sessionUsage: {} as Record<string, UsageSnapshot>,
  openSettings: vi.fn(),
  setSessionUsage: vi.fn(),
  clearSessionUsage: vi.fn(),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

// Stub the poller so the indicator test doesn't try to invoke Tauri.
vi.mock("../../../hooks/useSessionUsagePoller", () => ({
  useSessionUsagePoller: () => {},
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      if (typeof opts.defaultValue === "string") return opts.defaultValue;
      return key;
    },
  }),
}));

import { UsageIndicator } from "./UsageIndicator";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(
  props: { workspaceId: string | null; sessionId: string | null } = {
    workspaceId: "w1",
    sessionId: "s1",
  },
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<UsageIndicator {...props} />);
  });
  return container;
}

function makeBackend(
  kind: AgentBackendKind,
  id = `id-${kind}`,
): AgentBackendConfig {
  return {
    id,
    label: kind,
    kind,
    base_url: null,
    enabled: true,
    default_model: null,
    manual_models: [],
    discovered_models: [],
    auth_ref: null,
    capabilities: {
      thinking: false,
      effort: false,
      fast_mode: false,
      one_m_context: false,
      tools: true,
      vision: false,
    },
    context_window_default: 0,
    model_discovery: false,
    has_secret: false,
    runtime_harness: null,
  };
}

function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider_kind: "codex_native",
    source_label: "Codex Plus",
    buckets: [
      {
        key: "local_session",
        label: "This session",
        utilization: 0,
        primary_text: "12.4k tok",
        secondary_text: null,
        is_bounded: false,
        exhausted: false,
      },
    ],
    note: "Local tracking — based on tokens recorded by Claudette per turn.",
    fetched_at_ms: Date.now(),
    experimental_disabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  appStore.usageInsightsEnabled = false;
  appStore.agentBackends = [];
  appStore.selectedModelProvider = {};
  appStore.sessionUsage = {};
  appStore.openSettings = vi.fn();
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

describe("UsageIndicator", () => {
  it("hides when sessionId is null", async () => {
    const container = await render({ workspaceId: "w1", sessionId: null });
    expect(container.querySelector("button")).toBeNull();
  });

  it("hides when the session has no backend selected yet", async () => {
    // selectedModelProvider has no entry for s1
    appStore.agentBackends = [makeBackend("anthropic")];
    const container = await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders disabled state for Claude family when flag is off", async () => {
    const anthropic = makeBackend("anthropic", "anthropic");
    appStore.agentBackends = [anthropic];
    appStore.selectedModelProvider = { s1: "anthropic" };
    appStore.usageInsightsEnabled = false;
    const container = await render();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.className).toContain("disabled");
    expect(button?.textContent).toContain("—");
  });

  it("disabled-state click navigates to Experimental section", async () => {
    appStore.agentBackends = [makeBackend("anthropic", "anthropic")];
    appStore.selectedModelProvider = { s1: "anthropic" };
    const container = await render();
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(appStore.openSettings).toHaveBeenCalledWith(
      "experimental",
      "claude-code-usage",
    );
  });

  it("renders nothing for Codex Native without a snapshot yet", async () => {
    appStore.agentBackends = [makeBackend("codex_native", "codex")];
    appStore.selectedModelProvider = { s1: "codex" };
    const container = await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the active meter for Codex Native once the snapshot lands", async () => {
    appStore.agentBackends = [makeBackend("codex_native", "codex")];
    appStore.selectedModelProvider = { s1: "codex" };
    appStore.sessionUsage = { s1: makeSnapshot() };
    const container = await render();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("12.4k tok");
    expect(button?.className).not.toContain("disabled");
  });

  it("opens and closes the popover on click", async () => {
    appStore.agentBackends = [makeBackend("codex_native", "codex")];
    appStore.selectedModelProvider = { s1: "codex" };
    appStore.sessionUsage = { s1: makeSnapshot() };
    const container = await render();
    const button = container.querySelector("button")!;

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes the popover on Escape", async () => {
    appStore.agentBackends = [makeBackend("codex_native", "codex")];
    appStore.selectedModelProvider = { s1: "codex" };
    appStore.sessionUsage = { s1: makeSnapshot() };
    const container = await render();
    const button = container.querySelector("button")!;

    await act(async () => button.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
