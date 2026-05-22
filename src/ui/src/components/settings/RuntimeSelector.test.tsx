// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackendConfig } from "../../services/tauri";

const appStore = vi.hoisted(() => ({
  agentBackends: [] as AgentBackendConfig[],
  // Tests cover the full UI surface (Pi runtime included), so default
  // to the same shape a real Pi-compiled binary would produce. A
  // dedicated test below pins the no-Pi behaviour.
  piSdkAvailable: true,
  // Experimental gate consumed by RuntimeSelector via effectiveHarness.
  // Defaults to off because the selector's existing matrix tests don't
  // care about the interactive harness.
  claudeInteractiveEnabled: false,
}));

vi.mock("../../stores/useAppStore", () => {
  const useAppStore = <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore);
  useAppStore.getState = () => appStore;
  return { useAppStore };
});

const serviceMocks = vi.hoisted(() => ({
  setAgentBackendRuntimeHarness: vi.fn(
    (_id: string, _harness: unknown) => Promise.resolve([] as AgentBackendConfig[]),
  ),
  defaultHarnessForKind: (kind: AgentBackendConfig["kind"]) => {
    switch (kind) {
      case "anthropic":
      case "custom_anthropic":
      case "codex_subscription":
      case "openai_api":
      case "custom_openai":
        return "claude_code" as const;
      case "ollama":
      case "lm_studio":
        return "pi_sdk" as const;
      case "codex_native":
        return "codex_app_server" as const;
      case "pi_sdk":
        return "pi_sdk" as const;
    }
  },
  availableHarnessesForKind: (
    kind: AgentBackendConfig["kind"],
    options?: { claudeInteractiveEnabled?: boolean },
  ) => {
    const base: string[] = (() => {
      switch (kind) {
        case "anthropic":
        case "custom_anthropic":
        case "codex_subscription":
          return ["claude_code"];
        case "ollama":
        case "lm_studio":
          return ["pi_sdk", "claude_code"];
        case "openai_api":
        case "custom_openai":
          return ["claude_code", "pi_sdk"];
        case "codex_native":
          return ["codex_app_server", "pi_sdk"];
        case "pi_sdk":
          return ["pi_sdk"];
      }
    })();
    if (
      options?.claudeInteractiveEnabled === true &&
      (kind === "anthropic" ||
        kind === "custom_anthropic" ||
        kind === "codex_subscription")
    ) {
      base.push("claude_interactive");
    }
    return base;
  },
  effectiveHarness: (
    backend: AgentBackendConfig,
    options?: { claudeInteractiveEnabled?: boolean },
  ) => {
    const override = backend.runtime_harness ?? undefined;
    // Mirror the real `effectiveHarness` guard: `"claude_interactive"`
    // is only honored when the experimental flag is on (it's
    // intentionally absent from the per-kind matrix). Other persisted
    // overrides are honored when they appear in the kind's allow-list;
    // otherwise we fall through to the kind's default.
    if (
      override === "claude_interactive" &&
      options?.claudeInteractiveEnabled === true
    ) {
      return override;
    }
    if (
      override &&
      override !== "claude_interactive" &&
      serviceMocks
        .availableHarnessesForKind(backend.kind, options)
        .includes(override)
    ) {
      return override;
    }
    return serviceMocks.defaultHarnessForKind(backend.kind);
  },
}));

vi.mock("../../services/tauri", () => serviceMocks);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

import { RuntimeSelector } from "./RuntimeSelector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function makeBackend(overrides: Partial<AgentBackendConfig>): AgentBackendConfig {
  return {
    id: "test",
    label: "Test",
    kind: "ollama",
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
    context_window_default: 64_000,
    model_discovery: true,
    has_secret: false,
    ...overrides,
  };
}

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

describe("RuntimeSelector", () => {
  beforeEach(() => {
    appStore.agentBackends = [];
    serviceMocks.setAgentBackendRuntimeHarness.mockClear();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0).reverse()) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of mountedContainers.splice(0)) container.remove();
  });

  it("renders nothing when the kind has only one available harness", () => {
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "anthropic" })}
        onSaved={() => {}}
      />,
    );
    expect(container.querySelector("select")).toBeNull();
  });

  it("renders the kind's available harnesses with the default marked", () => {
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: true }),
    ];
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "ollama" })}
        onSaved={() => {}}
      />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.options).map((opt) => ({
      value: opt.value,
      text: opt.textContent ?? "",
      disabled: opt.disabled,
    }));
    expect(options.map((o) => o.value)).toEqual(["pi_sdk", "claude_code"]);
    expect(options[0]!.text).toMatch(/Pi.*default/i);
    expect(select.value).toBe("pi_sdk");
  });

  it("disables the Pi option when no Pi backend is enabled", () => {
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: false }),
    ];
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "lm_studio" })}
        onSaved={() => {}}
      />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    const piOption = Array.from(select.options).find((o) => o.value === "pi_sdk");
    expect(piOption?.disabled).toBe(true);
    expect(piOption?.textContent).toMatch(/Pi disabled|Pi.*disabled/i);
  });

  it("calls set_backend_runtime_harness with `null` when the user picks the kind's default", async () => {
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: true }),
    ];
    let savedSpy: AgentBackendConfig[] | null = null;
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "ollama", runtime_harness: "claude_code" })}
        onSaved={(saved) => {
          savedSpy = saved;
        }}
      />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("claude_code");
    await act(async () => {
      select.value = "pi_sdk";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serviceMocks.setAgentBackendRuntimeHarness).toHaveBeenCalledTimes(1);
    expect(serviceMocks.setAgentBackendRuntimeHarness).toHaveBeenCalledWith(
      "test",
      // ollama's default IS pi_sdk → pass null to clear the override.
      null,
    );
    expect(savedSpy).toEqual([]);
  });

  it("calls set_backend_runtime_harness with the harness when the user picks a non-default", async () => {
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: true }),
    ];
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "ollama" })}
        onSaved={() => {}}
      />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "claude_code";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(serviceMocks.setAgentBackendRuntimeHarness).toHaveBeenCalledWith(
      "test",
      "claude_code",
    );
  });

  it("hides the Claude (Interactive) option for an Anthropic backend when the flag is OFF", () => {
    // Default appStore.claudeInteractiveEnabled is false → the
    // Anthropic kind only has one available harness, so the selector
    // shouldn't render at all.
    appStore.claudeInteractiveEnabled = false;
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({ kind: "anthropic" })}
        onSaved={() => {}}
      />,
    );
    expect(container.querySelector("select")).toBeNull();
  });

  it("renders the Claude (Interactive) option for an Anthropic backend when the flag is ON", () => {
    appStore.claudeInteractiveEnabled = true;
    try {
      const container = mount(
        <RuntimeSelector
          backend={makeBackend({ kind: "anthropic", id: "anthropic" })}
          onSaved={() => {}}
        />,
      );
      const select = container.querySelector("select") as HTMLSelectElement;
      expect(select).not.toBeNull();
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).toEqual(["claude_code", "claude_interactive"]);
      // ClaudeCode is the kind's default → first entry is marked default.
      expect(select.options[0]!.textContent).toMatch(/default/i);
      // Currently selected is the kind default (no override persisted).
      expect(select.value).toBe("claude_code");
    } finally {
      appStore.claudeInteractiveEnabled = false;
    }
  });

  it("persists the claude_interactive harness when the user selects it (flag on)", async () => {
    appStore.claudeInteractiveEnabled = true;
    try {
      const container = mount(
        <RuntimeSelector
          backend={makeBackend({ kind: "anthropic", id: "anthropic" })}
          onSaved={() => {}}
        />,
      );
      const select = container.querySelector("select") as HTMLSelectElement;
      await act(async () => {
        select.value = "claude_interactive";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(serviceMocks.setAgentBackendRuntimeHarness).toHaveBeenCalledTimes(1);
      // claude_interactive is NOT the kind default, so the override is
      // passed through verbatim (not nulled out).
      expect(serviceMocks.setAgentBackendRuntimeHarness).toHaveBeenCalledWith(
        "anthropic",
        "claude_interactive",
      );
    } finally {
      appStore.claudeInteractiveEnabled = false;
    }
  });

  it("does not expose Claude (Interactive) for non-Claude-flavored kinds even when the flag is on", () => {
    // Ollama / LM Studio / OpenAI / CodexNative / PiSdk must never
    // surface claude_interactive — the harness is a Claude-runtime
    // variant only.
    appStore.claudeInteractiveEnabled = true;
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: true }),
    ];
    try {
      for (const kind of [
        "ollama",
        "lm_studio",
        "openai_api",
        "custom_openai",
        "codex_native",
      ] as const) {
        const container = mount(
          <RuntimeSelector
            backend={makeBackend({ kind })}
            onSaved={() => {}}
          />,
        );
        const select = container.querySelector("select");
        if (select) {
          const values = Array.from(select.options).map((o) => o.value);
          expect(values).not.toContain("claude_interactive");
        }
        container.remove();
      }
    } finally {
      appStore.claudeInteractiveEnabled = false;
    }
  });

  it("falls back to the kind's default when runtime_harness is claude_interactive but the flag is OFF", () => {
    // Regression: the previous mock unconditionally returned the
    // persisted override, including `"claude_interactive"`. The real
    // `effectiveHarness` honors `"claude_interactive"` only when the
    // experimental flag is on; otherwise it falls through to the kind's
    // default. The selector won't render for Anthropic (single available
    // harness with the flag off), so use Ollama where the kind has a
    // multi-entry matrix. Its default harness is `pi_sdk`.
    appStore.claudeInteractiveEnabled = false;
    appStore.agentBackends = [
      makeBackend({ id: "pi", kind: "pi_sdk", enabled: true }),
    ];
    const container = mount(
      <RuntimeSelector
        backend={makeBackend({
          kind: "ollama",
          runtime_harness: "claude_interactive",
        })}
        onSaved={() => {}}
      />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    // Flag is OFF → the persisted `claude_interactive` override is
    // dropped, and the effective harness is the kind's default (pi_sdk).
    expect(select.value).toBe("pi_sdk");
    // `claude_interactive` is NOT in the option list either (matrix gate).
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain("claude_interactive");
  });
});
