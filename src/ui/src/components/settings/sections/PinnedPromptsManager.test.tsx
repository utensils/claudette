// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedPrompt } from "../../../services/tauri";

const appStore = vi.hoisted(() => ({
  globalPinnedPrompts: [] as PinnedPrompt[],
  repoPinnedPrompts: {} as Record<string, PinnedPrompt[]>,
  setGlobalPinnedPrompts: vi.fn((prompts: PinnedPrompt[]) => {
    appStore.globalPinnedPrompts = prompts;
  }),
  setRepoPinnedPrompts: vi.fn(),
  upsertPinnedPrompt: vi.fn(),
  removePromptById: vi.fn(),
  loadGlobalPinnedPrompts: vi.fn(() => Promise.resolve()),
  loadRepoPinnedPrompts: vi.fn(() => Promise.resolve()),
  pushSettingsOverlay: vi.fn(),
  popSettingsOverlay: vi.fn(),
  // Read by `useModelRegistry`, which the launch-options model picker
  // mounts. Empty backends means the picker shows only the curated
  // Claude Code models — enough for these tests, which assert on the
  // prompt CRUD flow rather than on registry contents.
  alternativeBackendsEnabled: false,
  codexEnabled: false,
  agentBackends: [],
}));

const serviceMocks = vi.hoisted(() => ({
  createPinnedPrompt: vi.fn(),
  deletePinnedPrompt: vi.fn(() => Promise.resolve()),
  listSlashCommands: vi.fn(() => Promise.resolve([])),
  reorderPinnedPrompts: vi.fn(() => Promise.resolve()),
  updatePinnedPrompt: vi.fn(),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  createPinnedPrompt: serviceMocks.createPinnedPrompt,
  deletePinnedPrompt: serviceMocks.deletePinnedPrompt,
  listSlashCommands: serviceMocks.listSlashCommands,
  reorderPinnedPrompts: serviceMocks.reorderPinnedPrompts,
  updatePinnedPrompt: serviceMocks.updatePinnedPrompt,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.name ? `${key}:${values.name}` : key,
  }),
}));

import { PinnedPromptsManager } from "./PinnedPromptsManager";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function prompt(overrides: Partial<PinnedPrompt> = {}): PinnedPrompt {
  return {
    id: 1,
    repo_id: null,
    display_name: "Ship it",
    prompt: "Run the thing",
    auto_send: false,
    plan_mode: null,
    fast_mode: null,
    thinking_enabled: null,
    chrome_enabled: null,
    new_session: false,
    model: null,
    model_provider: null,
    sort_order: 0,
    created_at: "2026-05-14T00:00:00Z",
    ...overrides,
  };
}

async function renderManager(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<PinnedPromptsManager scope={{ kind: "global" }} />);
  });
  return container;
}

describe("PinnedPromptsManager", () => {
  beforeEach(() => {
    appStore.globalPinnedPrompts = [prompt()];
    appStore.repoPinnedPrompts = {};
    appStore.setGlobalPinnedPrompts.mockClear();
    appStore.setRepoPinnedPrompts.mockClear();
    appStore.upsertPinnedPrompt.mockClear();
    appStore.removePromptById.mockClear();
    appStore.loadGlobalPinnedPrompts.mockClear();
    appStore.loadRepoPinnedPrompts.mockClear();
    appStore.pushSettingsOverlay.mockClear();
    appStore.popSettingsOverlay.mockClear();
    serviceMocks.createPinnedPrompt.mockClear();
    serviceMocks.deletePinnedPrompt.mockClear();
    serviceMocks.listSlashCommands.mockClear();
    serviceMocks.reorderPinnedPrompts.mockClear();
    serviceMocks.updatePinnedPrompt.mockClear();
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

  it("Escape backs out of delete confirmation to edit mode", async () => {
    const container = await renderManager();
    const editButton = container.querySelector(
      'button[aria-label="pinned_prompts_edit_action:Ship it"]',
    );

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "pinned_prompts_delete_prompt",
    );
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const keepButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "pinned_prompts_keep",
    );
    expect(keepButton).toBeTruthy();

    await act(async () => {
      keepButton?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(container.textContent).not.toContain("pinned_prompts_keep");
    expect(container.textContent).not.toContain(
      "pinned_prompts_confirm_delete_title",
    );
    expect(container.textContent).toContain("pinned_prompts_delete_prompt");
  });

  it("shows the plan-mode override", async () => {
    const container = await renderManager();

    const editButton = container.querySelector(
      'button[aria-label="pinned_prompts_edit_action:Ship it"]',
    );
    if (!editButton) throw new Error("Expected Ship it edit button");
    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("pinned_prompts_override_plan_mode");
  });

  it("summarises launch options on the collapsed row", async () => {
    appStore.globalPinnedPrompts = [
      prompt({ new_session: true, model: "opus", model_provider: "anthropic" }),
    ];
    const container = await renderManager();

    expect(container.textContent).toContain(
      "pinned_prompts_launch_summary_new_session",
    );
    expect(container.textContent).toContain(
      "pinned_prompts_launch_summary_model",
    );
  });

  it("round-trips launch options through the edit form", async () => {
    appStore.globalPinnedPrompts = [
      prompt({ new_session: true, model: "sonnet", model_provider: "anthropic" }),
    ];
    serviceMocks.updatePinnedPrompt.mockImplementation((..._args: unknown[]) =>
      Promise.resolve(appStore.globalPinnedPrompts[0]),
    );
    const container = await renderManager();

    await act(async () => {
      container
        .querySelector('button[aria-label="pinned_prompts_edit_action:Ship it"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The picker reflects the stored model...
    const select = container.querySelector("select");
    if (!select) throw new Error("Expected a model picker");
    expect(select.value).toBe("sonnet");

    // ...and toggling "open in a new tab" off saves that change while
    // carrying the model through untouched, rather than silently resetting
    // the pin to "inherit".
    const newTabLabel = Array.from(container.querySelectorAll("label")).find(
      (l) => l.textContent?.includes("pinned_prompts_new_session"),
    );
    const newTabCheckbox = newTabLabel?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!newTabCheckbox) throw new Error("Expected the new-tab checkbox");
    expect(newTabCheckbox.checked).toBe(true);

    await act(async () => {
      newTabCheckbox.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent === "pinned_prompts_save_changes")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(serviceMocks.updatePinnedPrompt).toHaveBeenCalledWith(
      1,
      "Ship it",
      expect.any(String),
      expect.any(Boolean),
      expect.anything(),
      { new_session: false, model: "sonnet", model_provider: "anthropic" },
    );
  });

  it("keeps a model whose backend is no longer exposed, flagged as unavailable", async () => {
    // `qwen3-coder` only exists behind an Ollama backend, and the store stub
    // has none — so the registry can't resolve it. The pin must not lose the
    // user's choice just because the backend is off right now.
    appStore.globalPinnedPrompts = [
      prompt({ model: "qwen3-coder", model_provider: "ollama" }),
    ];
    const container = await renderManager();

    await act(async () => {
      container
        .querySelector('button[aria-label="pinned_prompts_edit_action:Ship it"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const select = container.querySelector("select");
    expect(select?.value).toBe("ollama/qwen3-coder");
    expect(container.textContent).toContain(
      "pinned_prompts_launch_model_unavailable_hint",
    );
  });

  it("decodes the stale option back to itself rather than to inherit", async () => {
    // The stale option's value isn't in the registry, so decoding used to
    // fall through to "inherit" and drop the pin's model. Re-selecting the
    // already-selected option doesn't fire `change` in a real browser, so
    // this guards the decode path rather than a reachable click — but the
    // path is one `<option>` away from being reachable, and silently
    // discarding a stored model is the exact failure the stale entry
    // exists to prevent.
    appStore.globalPinnedPrompts = [
      prompt({ model: "qwen3-coder", model_provider: "ollama" }),
    ];
    serviceMocks.updatePinnedPrompt.mockImplementation(() =>
      Promise.resolve(appStore.globalPinnedPrompts[0]),
    );
    const container = await renderManager();

    await act(async () => {
      container
        .querySelector('button[aria-label="pinned_prompts_edit_action:Ship it"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const select = container.querySelector("select");
    if (!select) throw new Error("Expected a model picker");
    await act(async () => {
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector("select")?.value).toBe("ollama/qwen3-coder");
    expect(container.textContent).toContain(
      "pinned_prompts_launch_model_unavailable_hint",
    );
  });

  it("treats moving off a stale model as a deliberate change", async () => {
    // The counterpart to the guard above: picking a live model really does
    // replace the stale one, and the phantom option disappears with it.
    // Cancelling the edit is the recovery path if that was a mistake.
    appStore.globalPinnedPrompts = [
      prompt({ model: "qwen3-coder", model_provider: "ollama" }),
    ];
    serviceMocks.updatePinnedPrompt.mockImplementation(() =>
      Promise.resolve(appStore.globalPinnedPrompts[0]),
    );
    const container = await renderManager();

    await act(async () => {
      container
        .querySelector('button[aria-label="pinned_prompts_edit_action:Ship it"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const select = container.querySelector("select");
    if (!select) throw new Error("Expected a model picker");
    await act(async () => {
      select.value = "opus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector("select")?.value).toBe("opus");
    expect(container.textContent).not.toContain(
      "pinned_prompts_launch_model_unavailable_hint",
    );

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent === "pinned_prompts_save_changes")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(serviceMocks.updatePinnedPrompt).toHaveBeenCalledWith(
      1,
      "Ship it",
      expect.any(String),
      expect.any(Boolean),
      expect.anything(),
      { new_session: false, model: "opus", model_provider: "anthropic" },
    );
  });

  it("Escape cancels an active row edit without deleting the prompt", async () => {
    const container = await renderManager();
    const editButton = container.querySelector(
      'button[aria-label="pinned_prompts_edit_action:Ship it"]',
    );
    if (!editButton) throw new Error("Expected Ship it edit button");

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const promptTextarea = container.querySelector("textarea");
    expect(promptTextarea?.value).toBe("Run the thing");

    await act(async () => {
      promptTextarea?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Ship it");
    expect(container.textContent).toContain("Run the thing");
    expect(serviceMocks.deletePinnedPrompt).not.toHaveBeenCalled();
  });
});
