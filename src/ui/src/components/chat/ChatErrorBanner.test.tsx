// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked store API — only the selectors/actions ChatErrorBanner reads. Each
// test mutates the in-memory object before mount; the selector mock just
// re-runs against the current state.
const appStore = vi.hoisted(() => ({
  openMissingCliModal: vi.fn(),
  setLastMissingWorktree: vi.fn(),
}));

vi.mock("../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

const tauriApi = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(async () => true),
  restoreWorkspace: vi.fn(async () => "/restored"),
}));

vi.mock("../../services/tauri", () => tauriApi);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.error ? `${key}:${values.error}` : key,
  }),
}));

import { ChatErrorBanner } from "./ChatErrorBanner";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(props: {
  message: string;
  workspaceId?: string | null;
  onRecovered?: () => void;
}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <ChatErrorBanner
        message={props.message}
        workspaceId={props.workspaceId ?? "ws-1"}
        onRecovered={props.onRecovered}
      />,
    );
  });
  return container;
}

describe("ChatErrorBanner", () => {
  beforeEach(() => {
    appStore.openMissingCliModal.mockReset();
    appStore.setLastMissingWorktree.mockReset();
    tauriApi.archiveWorkspace.mockReset().mockResolvedValue(true);
    tauriApi.restoreWorkspace.mockReset().mockResolvedValue("/restored");
  });

  afterEach(async () => {
    await act(async () => {
      mountedRoots.forEach((r) => r.unmount());
    });
    mountedContainers.forEach((c) => c.remove());
    mountedRoots.length = 0;
    mountedContainers.length = 0;
  });

  it("renders a plain error with no actions when message is unstructured", async () => {
    const container = await render({ message: "Something exploded." });
    // Plain banner has no buttons. This is the regression guard for "we
    // don't accidentally render archive/install actions on every error".
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("Something exploded.");
  });

  it("shows a single inline 'install options' link for missing-CLI errors and opens the modal on click", async () => {
    const container = await render({
      message: "Claude CLI is not installed. Click below for install options.",
    });
    const buttons = container.querySelectorAll("button");
    // CLI case: exactly one inline link, no archive/recreate actions.
    expect(buttons).toHaveLength(1);
    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(appStore.openMissingCliModal).toHaveBeenCalledTimes(1);
    expect(tauriApi.archiveWorkspace).not.toHaveBeenCalled();
    expect(tauriApi.restoreWorkspace).not.toHaveBeenCalled();
  });

  it("shows Archive + Recreate buttons for missing-worktree errors", async () => {
    const onRecovered = vi.fn();
    const container = await render({
      message: "Workspace directory is missing: /tmp/gone. The worktree was deleted.",
      onRecovered,
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    // Click Archive — should call archiveWorkspace, clear the cached path,
    // and notify the parent via onRecovered.
    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(tauriApi.archiveWorkspace).toHaveBeenCalledWith("ws-1");
    expect(appStore.setLastMissingWorktree).toHaveBeenCalledWith(null);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("shows action error and stays mounted when archive fails", async () => {
    tauriApi.archiveWorkspace.mockRejectedValueOnce(new Error("repo locked"));
    const onRecovered = vi.fn();
    const container = await render({
      message: "Workspace directory is missing: /tmp/gone. Recreate it.",
      onRecovered,
    });
    const archiveBtn = container.querySelectorAll("button")[0] as HTMLButtonElement;
    await act(async () => {
      archiveBtn.click();
    });
    // Failure path: we *don't* call onRecovered, and we surface the error
    // inline so the user can retry instead of losing context.
    expect(onRecovered).not.toHaveBeenCalled();
    expect(container.textContent).toContain("missing_worktree_archive_failed");
    expect(container.textContent).toContain("repo locked");
  });

  it("calls restoreWorkspace when Recreate is clicked", async () => {
    const onRecovered = vi.fn();
    const container = await render({
      message: "Workspace directory is missing: /tmp/gone. Recreate it.",
      onRecovered,
    });
    const recreateBtn = container.querySelectorAll("button")[1] as HTMLButtonElement;
    await act(async () => {
      recreateBtn.click();
    });
    expect(tauriApi.restoreWorkspace).toHaveBeenCalledWith("ws-1");
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });
});
