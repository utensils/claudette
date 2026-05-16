// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalEnvAutoOpen } from "./useTerminalEnvAutoOpen";

interface HarnessProps {
  selectedWorkspaceId: string | null;
  workspaceEnvironmentPreparing: boolean;
  claudetteTerminalEnabled: boolean;
  terminalPanelVisible: boolean;
  setTerminalPanelVisible: (visible: boolean) => void;
}

function Harness(props: HarnessProps) {
  useTerminalEnvAutoOpen(
    props.selectedWorkspaceId,
    props.workspaceEnvironmentPreparing,
    props.claudetteTerminalEnabled,
    props.terminalPanelVisible,
    props.setTerminalPanelVisible,
  );
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(props: HarnessProps) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness {...props} />);
  });
}

async function rerender(props: HarnessProps) {
  await act(async () => {
    root!.render(<Harness {...props} />);
  });
}

describe("useTerminalEnvAutoOpen", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("auto-opens terminal when env begins preparing and panel is hidden", async () => {
    const setVisible = vi.fn();
    await render({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not open terminal when already visible", async () => {
    const setVisible = vi.fn();
    await render({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: true,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();
  });

  it("does not open terminal when claudetteTerminalEnabled is false", async () => {
    const setVisible = vi.fn();
    await render({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: false,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();
  });

  it("does not open terminal when no workspace is selected", async () => {
    const setVisible = vi.fn();
    await render({
      selectedWorkspaceId: null,
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();
  });

  // Regression: terminal re-opened on every workspace switch because
  // selectWorkspace briefly resets env status to "preparing", and the old
  // string | null guard was cleared when env previously resolved to "ready".
  it("does not re-open terminal when switching back to a workspace already auto-opened", async () => {
    const setVisible = vi.fn();
    // First visit to ws-1: env preparing, panel hidden → auto-open fires.
    await render({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).toHaveBeenCalledExactlyOnceWith(true);
    setVisible.mockClear();

    // Env resolves to ready; user hides the terminal.
    await rerender({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: false,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();

    // Switch to ws-2 (not preparing).
    await rerender({
      selectedWorkspaceId: "ws-2",
      workspaceEnvironmentPreparing: false,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();

    // Switch back to ws-1: selectWorkspace sets env back to "preparing".
    // The panel must NOT re-open — user already closed it deliberately.
    await rerender({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).not.toHaveBeenCalled();
  });

  it("auto-opens for a new workspace that was never seen before", async () => {
    const setVisible = vi.fn();
    // ws-1 already resolved, user hid terminal.
    await render({
      selectedWorkspaceId: "ws-1",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    setVisible.mockClear();

    // Switch to brand-new ws-2 that starts preparing → should auto-open.
    await rerender({
      selectedWorkspaceId: "ws-2",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("auto-opens independently for multiple workspaces encountered in sequence", async () => {
    const setVisible = vi.fn();
    // ws-a preparing.
    await render({
      selectedWorkspaceId: "ws-a",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).toHaveBeenCalledTimes(1);

    // Switch to ws-b (also preparing).
    await rerender({
      selectedWorkspaceId: "ws-b",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    expect(setVisible).toHaveBeenCalledTimes(2);

    // Re-visit ws-a while it's still "preparing" (selectWorkspace reset it).
    await rerender({
      selectedWorkspaceId: "ws-a",
      workspaceEnvironmentPreparing: true,
      claudetteTerminalEnabled: true,
      terminalPanelVisible: false,
      setTerminalPanelVisible: setVisible,
    });
    // Must NOT fire a third time.
    expect(setVisible).toHaveBeenCalledTimes(2);
  });
});
