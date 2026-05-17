// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRemoteControlStatus } from "../../../services/tauri";

// --- Store mock ---------------------------------------------------------
//
// The component reads many session-scoped selectors; the mock returns
// safe defaults keyed off `sessionId`. `addToast` is captured so we can
// assert the user-facing copy that fires when an enable is queued or
// cancelled mid-turn.

interface MockState {
  selectedModel: Record<string, string>;
  selectedModelProvider: Record<string, string>;
  permissionLevel: Record<string, string>;
  fastMode: Record<string, boolean>;
  thinkingEnabled: Record<string, boolean>;
  planMode: Record<string, boolean>;
  effortLevel: Record<string, string>;
  chromeEnabled: Record<string, boolean>;
  claudeRemoteControlEnabled: boolean;
  setFastMode: ReturnType<typeof vi.fn>;
  setChromeEnabled: ReturnType<typeof vi.fn>;
  clearAgentQuestion: ReturnType<typeof vi.fn>;
  clearPlanApproval: ReturnType<typeof vi.fn>;
  clearAgentApproval: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
}

const appStore = vi.hoisted(
  () =>
    ({
      selectedModel: {},
      selectedModelProvider: {},
      permissionLevel: {},
      fastMode: {},
      thinkingEnabled: {},
      planMode: {},
      effortLevel: {},
      chromeEnabled: {},
      claudeRemoteControlEnabled: true,
      setFastMode: vi.fn(),
      setChromeEnabled: vi.fn(),
      clearAgentQuestion: vi.fn(),
      clearPlanApproval: vi.fn(),
      clearAgentApproval: vi.fn(),
      addToast: vi.fn(),
    }) satisfies MockState as MockState,
);

const serviceMocks = vi.hoisted(() => ({
  getClaudeRemoteControlStatus: vi.fn(
    (): Promise<ClaudeRemoteControlStatus> =>
      Promise.resolve({
        state: "disabled",
        sessionUrl: null,
        connectUrl: null,
        environmentId: null,
        detail: null,
        lastError: null,
      }),
  ),
  setClaudeRemoteControl: vi.fn(
    (): Promise<ClaudeRemoteControlStatus> =>
      Promise.resolve({
        state: "ready",
        sessionUrl: "https://claude.ai/code/sess",
        connectUrl: "https://claude.ai/code?bridge=env_test",
        environmentId: "env_test",
        detail: null,
        lastError: null,
      }),
  ),
  setAppSetting: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(() => Promise.resolve()),
  resetAgentSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: MockState) => T): T => selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  getClaudeRemoteControlStatus: serviceMocks.getClaudeRemoteControlStatus,
  setClaudeRemoteControl: serviceMocks.setClaudeRemoteControl,
  setAppSetting: serviceMocks.setAppSetting,
  openUrl: serviceMocks.openUrl,
  resetAgentSession: serviceMocks.resetAgentSession,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));

vi.mock("../useSelectedModelEntry", () => ({
  useSelectedModelEntry: () => ({ supportsFastMode: true }),
}));

vi.mock("../chatHelpers", () => ({
  shouldDisable1mContext: () => false,
}));

vi.mock("../modelCapabilities", () => ({
  isFastSupported: () => true,
}));

import { OverflowMenu } from "./OverflowMenu";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// --- Test harness -------------------------------------------------------

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderMenu(props: {
  sessionId?: string;
  disabled?: boolean;
  isRunning?: boolean;
  isRemote?: boolean;
}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <OverflowMenu
        sessionId={props.sessionId ?? "s1"}
        disabled={props.disabled ?? false}
        isRunning={props.isRunning ?? false}
        isRemote={props.isRemote ?? false}
      />,
    );
    // Allow the initial getClaudeRemoteControlStatus + listen effects to settle.
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

async function rerenderMenu(
  root: Root,
  props: {
    sessionId?: string;
    disabled?: boolean;
    isRunning?: boolean;
    isRemote?: boolean;
  },
): Promise<void> {
  await act(async () => {
    root.render(
      <OverflowMenu
        sessionId={props.sessionId ?? "s1"}
        disabled={props.disabled ?? false}
        isRunning={props.isRunning ?? false}
        isRemote={props.isRemote ?? false}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function triggerButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector(
    'button[aria-label="More options"]',
  ) as HTMLButtonElement | null;
  if (!btn) throw new Error("Overflow trigger not found");
  return btn;
}

async function openDropdown(container: HTMLElement): Promise<void> {
  await act(async () => {
    triggerButton(container).click();
    await Promise.resolve();
  });
}

function findRemoteControlButton(container: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const match = buttons.find((b) =>
    b.textContent?.includes("Claude Remote Control"),
  );
  if (!match) throw new Error("Remote Control row not found");
  return match;
}

function findMenuItemByLabel(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const match = buttons.find((b) => b.textContent?.includes(label));
  if (!match) throw new Error(`Menu item "${label}" not found`);
  return match;
}

beforeEach(() => {
  serviceMocks.getClaudeRemoteControlStatus.mockClear();
  serviceMocks.setClaudeRemoteControl.mockClear();
  serviceMocks.setAppSetting.mockClear();
  serviceMocks.resetAgentSession.mockClear();
  appStore.addToast.mockClear();
  appStore.setFastMode.mockClear();
  appStore.setChromeEnabled.mockClear();
  appStore.claudeRemoteControlEnabled = true;
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

// --- Scaffolding regressions -------------------------------------------
//
// These verify the *plumbing* changes (split `disabled` prop, mid-turn
// menu accessibility, MenuItem disabled prop). They do not depend on the
// user-implemented `toggle()` body.

describe("OverflowMenu — mid-turn reachability", () => {
  it("does not disable the trigger button when only isRunning is true", async () => {
    const { container } = await renderMenu({ isRunning: true });
    expect(triggerButton(container).disabled).toBe(false);
  });

  it("disables the trigger button when the workspace is preparing", async () => {
    const { container } = await renderMenu({ disabled: true });
    expect(triggerButton(container).disabled).toBe(true);
  });

  it("keeps Fast mode and Claude in Chrome disabled mid-turn (no session-mutation drift)", async () => {
    const { container } = await renderMenu({ isRunning: true });
    await openDropdown(container);
    expect(findMenuItemByLabel(container, "Fast mode").disabled).toBe(true);
    expect(findMenuItemByLabel(container, "Claude in Chrome").disabled).toBe(
      true,
    );
  });

  it("keeps Fast mode and Claude in Chrome enabled when idle", async () => {
    const { container } = await renderMenu({ isRunning: false });
    await openDropdown(container);
    expect(findMenuItemByLabel(container, "Fast mode").disabled).toBe(false);
    expect(findMenuItemByLabel(container, "Claude in Chrome").disabled).toBe(
      false,
    );
  });

  it("renders the Remote Control row mid-turn so the user can click it", async () => {
    const { container } = await renderMenu({ isRunning: true });
    await openDropdown(container);
    expect(() => findRemoteControlButton(container)).not.toThrow();
  });
});

// --- End-to-end toggle behavior ----------------------------------------
//
// These exercise the user-implemented `toggle()` callback per the sketch
// in `OverflowMenu.tsx`. They will fail against the placeholder body
// (which fires immediately) and pass once the queue / cancel / defer
// branches are wired up. Each test names the exact branch it covers.

describe("OverflowMenu — Remote Control mid-turn enable (user toggle)", () => {
  it("queues a pending enable instead of firing when clicked mid-turn", async () => {
    const { container } = await renderMenu({ isRunning: true });
    await openDropdown(container);

    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });

    expect(serviceMocks.setClaudeRemoteControl).not.toHaveBeenCalled();
    expect(appStore.addToast).toHaveBeenCalledWith(
      expect.stringContaining("when the current turn finishes"),
    );
    expect(container.textContent).toContain("pending");
  });

  it("fires the queued enable the moment the turn ends (isRunning → false)", async () => {
    const { container, root } = await renderMenu({ isRunning: true });
    await openDropdown(container);

    // Step 1: queue while running
    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });
    expect(serviceMocks.setClaudeRemoteControl).not.toHaveBeenCalled();

    // Step 2: the turn ends — the deferred-fire effect should fire once.
    await rerenderMenu(root, { isRunning: false });

    expect(serviceMocks.setClaudeRemoteControl).toHaveBeenCalledTimes(1);
    expect(serviceMocks.setClaudeRemoteControl).toHaveBeenCalledWith(
      "s1",
      true,
      expect.any(Object),
    );
  });

  it("cancels the pending enable when the row is clicked a second time", async () => {
    const { container, root } = await renderMenu({ isRunning: true });
    await openDropdown(container);

    // Queue
    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });
    appStore.addToast.mockClear();

    // Cancel
    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });

    expect(appStore.addToast).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );

    // After cancel, turn-end must NOT fire the enable.
    await rerenderMenu(root, { isRunning: false });
    expect(serviceMocks.setClaudeRemoteControl).not.toHaveBeenCalled();
  });

  it("fires immediately when clicked while idle (regression: existing path unchanged)", async () => {
    const { container } = await renderMenu({ isRunning: false });
    await openDropdown(container);

    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });

    expect(serviceMocks.setClaudeRemoteControl).toHaveBeenCalledTimes(1);
    expect(serviceMocks.setClaudeRemoteControl).toHaveBeenCalledWith(
      "s1",
      true,
      expect.any(Object),
    );
    expect(appStore.addToast).not.toHaveBeenCalled();
  });

  it("clears the pending intent when the user switches sessions", async () => {
    const { container, root } = await renderMenu({
      sessionId: "s1",
      isRunning: true,
    });
    await openDropdown(container);

    // Queue against s1
    await act(async () => {
      findRemoteControlButton(container).click();
      await Promise.resolve();
    });

    // Switch to s2 and end the turn — the previously queued intent must
    // NOT fire against the new session.
    await rerenderMenu(root, { sessionId: "s2", isRunning: false });

    expect(serviceMocks.setClaudeRemoteControl).not.toHaveBeenCalled();
  });
});
