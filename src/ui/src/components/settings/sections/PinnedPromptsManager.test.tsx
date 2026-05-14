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

  it("Escape cancels an active row edit without deleting the prompt", async () => {
    const container = await renderManager();
    const editButton = container.querySelector(
      'button[aria-label="pinned_prompts_edit_action:Ship it"]',
    );

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
