// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  connectRemoteConnection: vi.fn(),
  dropConnectionState: vi.fn(),
  isCertificateMismatch: (e: unknown) => String(e).includes("fingerprint mismatch"),
  resyncActiveConnection: vi.fn(),
  wasDisconnectedByUser: vi.fn(() => false),
}));
vi.mock("../components/sidebar/remoteConnectionActions", () => actions);

import { useAppStore } from "../stores/useAppStore";
import { RECONNECT_DELAYS_MS, scheduleReconnect } from "./useRemoteConnectionLifecycle";
import type { TFunction } from "i18next";

const t = ((key: string) => key) as unknown as TFunction<"sidebar">;
const conn = {
  id: "c1",
  name: "Box",
  host: "box.local",
  port: 7683,
  session_token: null,
  cert_fingerprint: "ff",
  auto_connect: true,
  created_at: "",
};

describe("scheduleReconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    actions.connectRemoteConnection.mockReset();
    useAppStore.setState({
      remoteConnections: [conn],
      activeRemoteIds: [],
      reconnectingRemoteIds: [],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off between failed attempts and stops once connected", async () => {
    actions.connectRemoteConnection
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);

    scheduleReconnect("c1", t, { announce: false });
    expect(useAppStore.getState().reconnectingRemoteIds).toEqual(["c1"]);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(actions.connectRemoteConnection).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1] - 1);
    expect(actions.connectRemoteConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(actions.connectRemoteConnection).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().reconnectingRemoteIds).toEqual([]);
  });

  it("gives up when the server's certificate changed", async () => {
    actions.connectRemoteConnection.mockRejectedValue(
      new Error("Certificate fingerprint mismatch!"),
    );
    scheduleReconnect("c1", t, { announce: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions.connectRemoteConnection).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().reconnectingRemoteIds).toEqual([]);
  });

  it("does nothing for a connection the user removed", async () => {
    scheduleReconnect("c1", t, { announce: false });
    useAppStore.setState({ remoteConnections: [] });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(actions.connectRemoteConnection).not.toHaveBeenCalled();
  });
});
