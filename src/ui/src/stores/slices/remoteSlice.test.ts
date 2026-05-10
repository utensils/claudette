import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";
import type { RemoteConnectionInfo } from "../../types/remote";

function makeRemoteConnection(
  overrides: Partial<RemoteConnectionInfo> = {},
): RemoteConnectionInfo {
  return {
    id: "rc-1",
    name: "host-a",
    host: "host-a.local",
    port: 7683,
    session_token: "tok-original",
    cert_fingerprint: "fp-original",
    auto_connect: false,
    created_at: "1700000000",
    ...overrides,
  };
}

describe("remoteSlice.addRemoteConnection", () => {
  beforeEach(() => {
    useAppStore.setState({ remoteConnections: [], activeRemoteIds: [] });
  });

  it("appends a connection when the id is new", () => {
    useAppStore.getState().addRemoteConnection(makeRemoteConnection());
    expect(useAppStore.getState().remoteConnections).toHaveLength(1);
  });

  // Regression: re-pairing the same host returns the existing row's id
  // (the backend now upserts by host:port). An unconditional append
  // would leave a stale duplicate behind the refreshed row.
  it("replaces in place when the same id is re-added (re-pair regression)", () => {
    useAppStore.getState().addRemoteConnection(makeRemoteConnection());
    useAppStore.getState().addRemoteConnection(
      makeRemoteConnection({
        session_token: "tok-fresh",
        cert_fingerprint: "fp-fresh",
        name: "host-a (renamed)",
      }),
    );
    const conns = useAppStore.getState().remoteConnections;
    expect(conns).toHaveLength(1);
    expect(conns[0].session_token).toBe("tok-fresh");
    expect(conns[0].cert_fingerprint).toBe("fp-fresh");
    expect(conns[0].name).toBe("host-a (renamed)");
  });

  it("keeps distinct ids as separate entries", () => {
    useAppStore.getState().addRemoteConnection(makeRemoteConnection({ id: "rc-1" }));
    useAppStore.getState().addRemoteConnection(makeRemoteConnection({ id: "rc-2" }));
    expect(useAppStore.getState().remoteConnections.map((c) => c.id)).toEqual([
      "rc-1",
      "rc-2",
    ]);
  });
});
