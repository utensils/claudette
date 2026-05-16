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
  setModelSelectorOpen: vi.fn(),
}));

vi.mock("../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

type LifecycleResult = { ok: true } | { ok: false; error: unknown };

const lifecycle = vi.hoisted(() => ({
  archive: vi.fn<(id: string, opts?: { skipScript?: boolean }) => Promise<LifecycleResult>>(
    async () => ({ ok: true }),
  ),
  restore: vi.fn<(id: string) => Promise<LifecycleResult>>(async () => ({ ok: true })),
}));

vi.mock("../../hooks/useWorkspaceLifecycle", () => ({
  useWorkspaceLifecycle: () => lifecycle,
}));

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
  sessionId?: string | null;
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
        sessionId={"sessionId" in props ? props.sessionId : "sess-1"}
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
    appStore.setModelSelectorOpen.mockReset();
    lifecycle.archive.mockReset().mockResolvedValue({ ok: true });
    lifecycle.restore.mockReset().mockResolvedValue({ ok: true });
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
    expect(lifecycle.archive).not.toHaveBeenCalled();
    expect(lifecycle.restore).not.toHaveBeenCalled();
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
    // `useWorkspaceLifecycle().archive` is invoked with `skipScript: true`
    // because the worktree is gone — any archive_script that would chdir
    // into it would fail anyway, so bypassing keeps the recovery path
    // unblocked.
    expect(lifecycle.archive).toHaveBeenCalledWith("ws-1", { skipScript: true });
    expect(appStore.setLastMissingWorktree).toHaveBeenCalledWith(null);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("shows action error and stays mounted when archive fails", async () => {
    lifecycle.archive.mockResolvedValueOnce({ ok: false, error: new Error("repo locked") });
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
    expect(lifecycle.restore).toHaveBeenCalledWith("ws-1");
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("shows a 'choose larger-context model' link for context-window-exceeded errors", async () => {
    const container = await render({
      message:
        "API error 400: This model's maximum context length is 8192 tokens, however the conversation requires 30000.",
    });
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(container.textContent).toContain("context_overflow_pick_model");
    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });
    // Clicking the recovery affordance opens the toolbar's model
    // selector so the user can pick a larger-context model without
    // having to find the picker themselves.
    expect(appStore.setModelSelectorOpen).toHaveBeenCalledWith(true);
    // The model-picker recovery does not call openMissingCliModal or
    // any worktree action — those are separate error classes.
    expect(appStore.openMissingCliModal).not.toHaveBeenCalled();
    expect(lifecycle.archive).not.toHaveBeenCalled();
    expect(lifecycle.restore).not.toHaveBeenCalled();
  });

  it("does not render the model-picker affordance when there is no sessionId", async () => {
    const container = await render({
      message: "Input is too long for requested model.",
      sessionId: null,
    });
    // Without a sessionId the picker can't be targeted, so the
    // affordance is hidden. The banner still shows the error text.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("Input is too long");
  });
});
