// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteServices = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(),
  connectRemote: vi.fn(),
  createWorkspace: vi.fn(),
  deleteAppSetting: vi.fn(),
  disconnectRemote: vi.fn(),
  generateWorkspaceName: vi.fn(),
  getRepoConfig: vi.fn(),
  listDiscoveredServers: vi.fn(),
  pairWithServer: vi.fn(),
  removeRemoteConnection: vi.fn(),
  renameWorkspace: vi.fn(),
  reorderRepositories: vi.fn(),
  reorderWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  runWorkspaceSetup: vi.fn(),
  sendRemoteCommand: vi.fn(),
  startLocalServer: vi.fn(),
  startRemoteDiscovery: vi.fn(),
}));

const store = vi.hoisted(() => ({
  addActiveRemoteId: vi.fn(),
  clearRemoteData: vi.fn(),
  discoveredServers: [],
  mergeRemoteData: vi.fn(),
  remoteConnections: [],
  removeRemoteConnection: vi.fn(),
  setDiscoveredServers: vi.fn(),
}));

vi.mock("../../services/tauri", () => remoteServices);

vi.mock("../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof store) => T): T => selector(store),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../layout/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

vi.mock("../shared/ContextMenu", () => ({
  ContextMenu: () => null,
}));

vi.mock("../shared/RepoIcon", () => ({
  RepoIcon: () => null,
}));

vi.mock("../shared/TabDragGhost", () => ({
  TabDragGhost: () => null,
}));

vi.mock("./HelpMenu", () => ({
  HelpMenu: () => null,
}));

vi.mock("../../hooks/useTabDragReorder", () => ({
  useTabDragReorder: () => ({
    dragPreview: null,
    draggedId: null,
    dropTargetIdx: null,
    getDraggableProps: () => ({}),
  }),
}));

import { RemoteSections } from "./Sidebar";

const discoveredServer = {
  name: "Studio Mac",
  host: "studio-mac.local",
  port: 7683,
  cert_fingerprint_prefix: "feed1234",
  is_paired: false,
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderRemoteSections(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<RemoteSections />);
  });
  await act(flushPromises);
  return root;
}

describe("RemoteSections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    Object.values(remoteServices).forEach((mock) => mock.mockReset());
    store.addActiveRemoteId.mockReset();
    store.clearRemoteData.mockReset();
    store.mergeRemoteData.mockReset();
    store.removeRemoteConnection.mockReset();
    store.setDiscoveredServers.mockReset();
    store.discoveredServers = [];
    store.remoteConnections = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts nearby discovery from the sidebar and polls while mounted", async () => {
    remoteServices.startRemoteDiscovery.mockResolvedValueOnce([discoveredServer]);
    remoteServices.listDiscoveredServers.mockResolvedValueOnce([]);

    const root = await renderRemoteSections();
    const button = document.querySelector("button");
    expect(button?.textContent).toBe("nearby_find");

    await act(async () => {
      button?.click();
      await flushPromises();
    });

    expect(remoteServices.startRemoteDiscovery).toHaveBeenCalledOnce();
    expect(store.setDiscoveredServers).toHaveBeenCalledWith([discoveredServer]);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await flushPromises();
    });

    expect(remoteServices.listDiscoveredServers).toHaveBeenCalledOnce();
    expect(store.setDiscoveredServers).toHaveBeenLastCalledWith([]);

    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await flushPromises();
    });

    expect(remoteServices.listDiscoveredServers).toHaveBeenCalledOnce();
  });
});
