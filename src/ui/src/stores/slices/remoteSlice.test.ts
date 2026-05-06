import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../useAppStore";
import type { RemoteConnectionInfo } from "../../types";

const makeConn = (
  id: string,
  host: string,
  overrides: Partial<RemoteConnectionInfo> = {},
): RemoteConnectionInfo => ({
  id,
  name: `Server ${id}`,
  host,
  port: 7683,
  session_token: `tok-${id}`,
  cert_fingerprint: `fp-${id}`,
  auto_connect: false,
  created_at: "",
  ...overrides,
});

describe("remoteSlice.addRemoteConnection", () => {
  beforeEach(() => {
    useAppStore.setState({ remoteConnections: [], activeRemoteIds: [] });
  });

  it("appends when the id is new", () => {
    useAppStore.getState().addRemoteConnection(makeConn("rc1", "host-a.local"));
    useAppStore.getState().addRemoteConnection(makeConn("rc2", "host-b.local"));
    const conns = useAppStore.getState().remoteConnections;
    expect(conns.map((c) => c.id)).toEqual(["rc1", "rc2"]);
  });

  // Re-pairing with the same host yields the same persisted id from the
  // backend; the slice must replace in place so the sidebar doesn't show a
  // duplicate alongside the now-defunct entry.
  it("replaces in place when an entry with the same id already exists", () => {
    useAppStore
      .getState()
      .addRemoteConnection(makeConn("rc1", "host-a.local", { name: "old" }));
    useAppStore
      .getState()
      .addRemoteConnection(makeConn("rc1", "host-a.local", { name: "new" }));
    const conns = useAppStore.getState().remoteConnections;
    expect(conns).toHaveLength(1);
    expect(conns[0].name).toBe("new");
  });

  it("preserves array order when replacing", () => {
    useAppStore.getState().addRemoteConnection(makeConn("rc1", "host-a.local"));
    useAppStore.getState().addRemoteConnection(makeConn("rc2", "host-b.local"));
    useAppStore.getState().addRemoteConnection(makeConn("rc3", "host-c.local"));
    useAppStore
      .getState()
      .addRemoteConnection(makeConn("rc2", "host-b.local", { name: "B!" }));
    const conns = useAppStore.getState().remoteConnections;
    expect(conns.map((c) => c.id)).toEqual(["rc1", "rc2", "rc3"]);
    expect(conns[1].name).toBe("B!");
  });
});
