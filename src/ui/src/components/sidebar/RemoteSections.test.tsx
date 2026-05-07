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

async function renderRemoteSections(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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
  });

  afterEach(() => {
    document.body.innerHTML = "";
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
});
