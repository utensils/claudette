// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredServer, RemoteConnectionInfo } from "../../types/remote";

interface RemoteSectionsStore {
  activeRemoteIds: string[];
  addActiveRemoteId: ReturnType<typeof vi.fn>;
  addRemoteConnection: ReturnType<typeof vi.fn>;
  clearRemoteData: ReturnType<typeof vi.fn>;
  discoveredServers: DiscoveredServer[];
  mergeRemoteData: ReturnType<typeof vi.fn>;
  remoteConnections: RemoteConnectionInfo[];
  removeActiveRemoteId: ReturnType<typeof vi.fn>;
  removeRemoteConnection: ReturnType<typeof vi.fn>;
  reconnectingRemoteIds: string[];
  openModal: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
  repositories: unknown[];
  workspaces: unknown[];
  repoCollapsed: Record<string, boolean>;
  selectedWorkspaceId: string | null;
  selectWorkspace: ReturnType<typeof vi.fn>;
  addWorkspace: ReturnType<typeof vi.fn>;
  updateWorkspace: ReturnType<typeof vi.fn>;
  markWorkspaceAsUnread: ReturnType<typeof vi.fn>;
  toggleRepoCollapsed: ReturnType<typeof vi.fn>;
}

const remoteServices = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(),
  connectRemote: vi.fn(),
  createWorkspace: vi.fn(),
  deleteAppSetting: vi.fn(),
  disconnectRemote: vi.fn(),
  generateWorkspaceName: vi.fn(),
  getRepoConfig: vi.fn(),
  pairWithServer: vi.fn(),
  removeRemoteConnection: vi.fn(),
  renameWorkspace: vi.fn(),
  reorderRepositories: vi.fn(),
  reorderWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  runWorkspaceSetup: vi.fn(),
  sendRemoteCommand: vi.fn(),
  startLocalServer: vi.fn(),
}));

const store = vi.hoisted(
  (): RemoteSectionsStore => ({
    activeRemoteIds: [],
    addActiveRemoteId: vi.fn(),
    addRemoteConnection: vi.fn(),
    clearRemoteData: vi.fn(),
    discoveredServers: [],
    mergeRemoteData: vi.fn(),
    remoteConnections: [],
    removeActiveRemoteId: vi.fn(),
    removeRemoteConnection: vi.fn(),
    reconnectingRemoteIds: [],
    openModal: vi.fn(),
    addToast: vi.fn(),
    repositories: [],
    workspaces: [],
    repoCollapsed: {},
    selectedWorkspaceId: null,
    selectWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    markWorkspaceAsUnread: vi.fn(),
    toggleRepoCollapsed: vi.fn(),
  }),
);

vi.mock("../../services/tauri", () => remoteServices);

const lifecycle = vi.hoisted(() => ({ stopReconnecting: vi.fn() }));
vi.mock("../../hooks/useRemoteConnectionLifecycle", () => lifecycle);

const connectionActions = vi.hoisted(() => ({
  connectRemoteConnection: vi.fn(),
  disconnectRemoteConnection: vi.fn(),
  forgetRemoteConnection: vi.fn(),
}));
vi.mock("./remoteConnectionActions", async (importActual) => ({
  ...(await importActual<typeof import("./remoteConnectionActions")>()),
  ...connectionActions,
}));

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

import { RemoteSections } from "./RemoteSections";

const discoveredServer = {
  name: "Studio Mac",
  host: "studio-mac.local",
  port: 7683,
  cert_fingerprint_prefix: "feed1234",
  is_paired: false,
};

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderRemoteSections(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<RemoteSections />);
  });
  return root;
}

describe("RemoteSections", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.values(remoteServices).forEach((mock) => mock.mockReset());
    store.activeRemoteIds = [];
    store.discoveredServers = [];
    store.remoteConnections = [];
    store.reconnectingRemoteIds = [];
    store.addToast.mockReset();
    lifecycle.stopReconnecting.mockReset();
    Object.values(connectionActions).forEach((mock) => mock.mockReset());
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

  it("hides Nearby when no unpaired servers are discovered", async () => {
    await renderRemoteSections();

    expect(document.body.textContent).not.toContain("nearby_section");
  });

  it("shows Nearby only when an unpaired server exists", async () => {
    store.discoveredServers = [discoveredServer];

    await renderRemoteSections();

    expect(document.body.textContent).toContain("nearby_section");
    expect(document.body.textContent).toContain("Studio Mac");
    expect(document.body.textContent).toContain("studio-mac.local");
  });

  it("opens the pairing modal with the advertised fingerprint", async () => {
    store.discoveredServers = [discoveredServer];
    store.openModal.mockReset();

    await renderRemoteSections();
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "workspace_connect",
    );
    await act(async () => {
      button?.click();
    });

    expect(store.openModal).toHaveBeenCalledWith("pairRemote", {
      host: "studio-mac.local",
      port: 7683,
      name: "Studio Mac",
      fingerprintPrefix: "feed1234",
    });
  });

  describe("a saved server that is reconnecting", () => {
    const saved: RemoteConnectionInfo = {
      id: "c1",
      name: "Box",
      host: "box.local",
      port: 7683,
      session_token: null,
      cert_fingerprint: "ff",
      auto_connect: true,
      created_at: "",
    };

    function button(title: string): HTMLButtonElement | undefined {
      return [...document.querySelectorAll("button")].find(
        (b) => b.title === title,
      );
    }

    beforeEach(() => {
      store.remoteConnections = [saved];
      store.reconnectingRemoteIds = ["c1"];
    });

    it("can be cancelled", async () => {
      await renderRemoteSections();
      const cancel = button("remote_cancel_reconnect");
      expect(cancel?.disabled).toBe(false);
      await act(async () => {
        cancel?.click();
      });
      expect(lifecycle.stopReconnecting).toHaveBeenCalledWith("c1");
      expect(connectionActions.disconnectRemoteConnection).toHaveBeenCalledWith("c1");
    });

    it("can be removed, and says when its access couldn't be revoked", async () => {
      connectionActions.forgetRemoteConnection.mockResolvedValue({
        revoked: false,
        revoke_error: "timed out",
      });
      await renderRemoteSections();
      await act(async () => {
        button("remote_remove")?.click();
      });
      expect(lifecycle.stopReconnecting).toHaveBeenCalledWith("c1");
      expect(connectionActions.forgetRemoteConnection).toHaveBeenCalledWith("c1");
      expect(store.addToast).toHaveBeenCalledWith("remote_revoke_failed");
    });
  });
});
