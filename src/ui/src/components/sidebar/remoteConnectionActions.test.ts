import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  connectRemote: vi.fn(),
  disconnectRemote: vi.fn(),
  forgetRemotePtys: vi.fn(),
  pairWithServer: vi.fn(),
  removeRemoteConnection: vi.fn(),
  sendRemoteCommand: vi.fn(),
  setRemoteAutoConnect: vi.fn(),
}));
vi.mock("../../services/tauri", () => tauri);
vi.mock("../chat/remotePendingControls", () => ({
  hydrateConnectionPendingControls: vi.fn(),
}));

import { useAppStore } from "../../stores/useAppStore";
import {
  connectRemoteConnection,
  disconnectRemoteConnection,
  forgetRemoteConnection,
  resyncActiveConnection,
} from "./remoteConnectionActions";

const CONN = {
  id: "c1",
  name: "Server",
  host: "server.local",
  port: 7683,
  session_token: null,
  cert_fingerprint: null,
  auto_connect: false,
  created_at: "0",
};

const EMPTY_DATA = {
  repositories: [],
  workspaces: [],
  worktree_base_dir: "",
  default_branches: {},
  last_messages: [],
};

/** A `connectRemote` call the test resolves by hand. */
function deferredConnect(): () => void {
  let resolve!: (value: unknown) => void;
  tauri.connectRemote.mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  return () => resolve(EMPTY_DATA);
}

describe("connectRemoteConnection", () => {
  beforeEach(() => {
    for (const fn of Object.values(tauri)) fn.mockReset();
    tauri.disconnectRemote.mockResolvedValue(undefined);
    tauri.setRemoteAutoConnect.mockResolvedValue(undefined);
    tauri.removeRemoteConnection.mockResolvedValue({ revoked: true, revoke_error: null });
    useAppStore.setState({ remoteConnections: [CONN], activeRemoteIds: [] });
  });

  it("adopts a connection nothing superseded", async () => {
    tauri.connectRemote.mockResolvedValue(EMPTY_DATA);
    await expect(connectRemoteConnection("c1")).resolves.toBe(true);
    expect(useAppStore.getState().activeRemoteIds).toEqual(["c1"]);
    expect(useAppStore.getState().remoteConnections[0].auto_connect).toBe(true);
  });

  it("closes an attempt that finishes after the user disconnected", async () => {
    const finish = deferredConnect();
    const attempt = connectRemoteConnection("c1");
    await disconnectRemoteConnection("c1");
    expect(tauri.disconnectRemote).toHaveBeenCalledTimes(1);

    finish();
    await expect(attempt).resolves.toBe(false);
    // Rust registered the socket after the disconnect; it's closed again.
    expect(tauri.disconnectRemote).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().activeRemoteIds).toEqual([]);
    expect(tauri.setRemoteAutoConnect).not.toHaveBeenCalledWith("c1", true);
  });

  it("closes an attempt that finishes after the server was removed", async () => {
    const finish = deferredConnect();
    const attempt = connectRemoteConnection("c1");
    await forgetRemoteConnection("c1");

    finish();
    await expect(attempt).resolves.toBe(false);
    expect(tauri.disconnectRemote).toHaveBeenCalledWith("c1");
    expect(useAppStore.getState().activeRemoteIds).toEqual([]);
  });

  it("runs a newer connect after the older one without closing it", async () => {
    const finishFirst = deferredConnect();
    tauri.connectRemote.mockResolvedValueOnce(EMPTY_DATA);
    const first = connectRemoteConnection("c1");
    const second = connectRemoteConnection("c1");
    // The second attempt waits for the first.
    expect(tauri.connectRemote).toHaveBeenCalledTimes(1);

    finishFirst();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(tauri.connectRemote).toHaveBeenCalledTimes(2);
    expect(tauri.disconnectRemote).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeRemoteIds).toEqual(["c1"]);
  });
});

describe("resyncActiveConnection", () => {
  beforeEach(() => {
    tauri.sendRemoteCommand.mockReset();
    useAppStore.setState({ remoteConnections: [CONN], activeRemoteIds: [] });
  });

  it("collapses requests made mid-resync into one more pass", async () => {
    let finish!: (value: unknown) => void;
    tauri.sendRemoteCommand
      .mockImplementationOnce(() => new Promise((r) => (finish = r)))
      .mockResolvedValue(EMPTY_DATA);
    const first = resyncActiveConnection("c1");
    resyncActiveConnection("c1");
    resyncActiveConnection("c1");
    finish(EMPTY_DATA);
    await first;
    expect(tauri.sendRemoteCommand).toHaveBeenCalledTimes(2);
  });
});
