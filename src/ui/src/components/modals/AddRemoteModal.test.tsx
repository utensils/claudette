// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remoteServices = vi.hoisted(() => ({
  addRemoteConnection: vi.fn(),
  listDiscoveredServers: vi.fn(),
  startRemoteDiscovery: vi.fn(),
}));

const store = vi.hoisted(() => ({
  addActiveRemoteId: vi.fn(),
  addRemoteConnection: vi.fn(),
  closeModal: vi.fn(),
  mergeRemoteData: vi.fn(),
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

import { AddRemoteModal } from "./AddRemoteModal";

const discoveredServer = {
  name: "Dev Mac",
  host: "dev-mac.local",
  port: 7683,
  cert_fingerprint_prefix: "abcd1234",
  is_paired: false,
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderModal(): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AddRemoteModal />);
  });
  await act(flushPromises);
  return root;
}

describe("AddRemoteModal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    Object.values(remoteServices).forEach((mock) => mock.mockReset());
    Object.values(store).forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts LAN discovery only when the Add Remote flow opens", async () => {
    remoteServices.startRemoteDiscovery.mockResolvedValueOnce([discoveredServer]);
    remoteServices.listDiscoveredServers.mockResolvedValueOnce([]);

    const root = await renderModal();

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
