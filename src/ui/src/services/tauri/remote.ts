import { invoke } from "@tauri-apps/api/core";
import type {
  DiscoveredServer,
  PairResult,
  RemoveResult,
  RemoteConnectionInfo,
  RemoteInitialData,
} from "../../types/remote";

export function listRemoteConnections(): Promise<RemoteConnectionInfo[]> {
  return invoke("list_remote_connections");
}

/**
 * Pair with a server. Pass the fingerprint prefix it advertised over mDNS
 * so the Rust side refuses to send the token to a different certificate.
 */
export function pairWithServer(
  host: string,
  port: number,
  pairingToken: string,
  expectedFingerprintPrefix?: string,
): Promise<PairResult> {
  return invoke("pair_with_server", {
    host,
    port,
    pairingToken,
    expectedFingerprintPrefix: expectedFingerprintPrefix ?? null,
  });
}

/** IDs of remote connections currently open on the Rust side. */
export function listActiveRemoteConnections(): Promise<string[]> {
  return invoke("list_active_remote_connections");
}

export function setRemoteAutoConnect(
  id: string,
  autoConnect: boolean,
): Promise<void> {
  return invoke("set_remote_auto_connect", { id, autoConnect });
}

export function connectRemote(id: string): Promise<RemoteInitialData | null> {
  return invoke("connect_remote", { id });
}

export function disconnectRemote(id: string): Promise<void> {
  return invoke("disconnect_remote", { id });
}

export function removeRemoteConnection(id: string): Promise<RemoveResult> {
  return invoke("remove_remote_connection", { id });
}

export function listDiscoveredServers(): Promise<DiscoveredServer[]> {
  return invoke("list_discovered_servers");
}

export function addRemoteConnection(
  connectionString: string
): Promise<PairResult> {
  return invoke("add_remote_connection", { connectionString });
}

export function sendRemoteCommand(
  connectionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return invoke("send_remote_command", { connectionId, method, params });
}
