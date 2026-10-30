import {
  connectRemote,
  disconnectRemote,
  forgetRemotePtys,
  pairWithServer,
  removeRemoteConnection,
  sendRemoteCommand,
  setRemoteAutoConnect,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type {
  PairResult,
  RemoteInitialData,
  RemoveResult,
} from "../../types/remote";
import { hydrateConnectionPendingControls } from "../chat/remotePendingControls";

/**
 * Connection lifecycle for paired servers, shared by the sidebar and the
 * app-level reconnect / auto-connect logic so both keep the store in the
 * same shape: `activeRemoteIds` lists live connections, and each live
 * connection's repos / workspaces are merged into the main lists.
 */

/** Connections the user explicitly disconnected this session. Auto-connect
 *  and reconnect leave these alone until the user connects again. */
const userDisconnected = new Set<string>();

export function wasDisconnectedByUser(id: string): boolean {
  return userDisconnected.has(id);
}

function adoptConnection(id: string, data: RemoteInitialData | null): void {
  const state = useAppStore.getState();
  state.addActiveRemoteId(id);
  if (data) state.mergeRemoteData(id, data);
  // Approval prompts raised while this window wasn't listening.
  hydrateConnectionPendingControls(id);
}

export async function connectRemoteConnection(id: string): Promise<void> {
  userDisconnected.delete(id);
  const data = await connectRemote(id);
  adoptConnection(id, data);
  rememberAutoConnect(id, true);
}

/** A manual disconnect also stops the server auto-connecting at launch;
 *  connecting again turns it back on. */
export async function disconnectRemoteConnection(id: string): Promise<void> {
  userDisconnected.add(id);
  await disconnectRemote(id);
  dropConnectionState(id);
  rememberAutoConnect(id, false);
}

function rememberAutoConnect(id: string, autoConnect: boolean): void {
  const state = useAppStore.getState();
  const conn = state.remoteConnections.find((c) => c.id === id);
  if (!conn || conn.auto_connect === autoConnect) return;
  state.setRemoteConnections(
    state.remoteConnections.map((c) =>
      c.id === id ? { ...c, auto_connect: autoConnect } : c,
    ),
  );
  setRemoteAutoConnect(id, autoConnect).catch((e) =>
    console.error("Failed to save auto-connect:", e),
  );
}

/** Remove a saved server, revoking this device's session on it. The
 *  entry is removed even when revocation fails; the result says so. */
export async function forgetRemoteConnection(id: string): Promise<RemoveResult> {
  userDisconnected.add(id);
  const result = await removeRemoteConnection(id);
  dropConnectionState(id);
  useAppStore.getState().removeRemoteConnection(id);
  return result;
}

/** Pair (or re-pair) with a server and adopt the resulting connection. */
export async function pairRemoteServer(
  host: string,
  port: number,
  pairingToken: string,
  expectedFingerprintPrefix?: string,
): Promise<PairResult> {
  const result = await pairWithServer(
    host,
    port,
    pairingToken,
    expectedFingerprintPrefix,
  );
  adoptPairResult(result);
  return result;
}

/** Store bookkeeping after any successful pair (Nearby or connection string). */
export function adoptPairResult(result: PairResult): void {
  const state = useAppStore.getState();
  const id = result.connection.id;
  userDisconnected.delete(id);
  if (state.remoteConnections.some((c) => c.id === id)) {
    state.setRemoteConnections(
      state.remoteConnections.map((c) => (c.id === id ? result.connection : c)),
    );
  } else {
    state.addRemoteConnection(result.connection);
  }
  adoptConnection(id, result.initial_data);
}

/**
 * Re-adopt a connection the Rust side still holds: after a webview reload
 * (the store is empty but the socket is up) or after events were lost.
 */
export async function resyncActiveConnection(id: string): Promise<void> {
  const data = (await sendRemoteCommand(
    id,
    "load_initial_data",
    {},
  )) as RemoteInitialData | null;
  adoptConnection(id, data);
}

/** Clear a connection's live state (on disconnect or loss). */
export function dropConnectionState(id: string): void {
  const state = useAppStore.getState();
  state.removeActiveRemoteId(id);
  state.clearRemoteData(id);
  forgetRemotePtys(id);
}

/** True when a connect error means the server's certificate changed. */
export function isCertificateMismatch(error: unknown): boolean {
  return String(error).includes("fingerprint mismatch");
}

/** True when a connect error means the server no longer accepts this
 *  device's session (revoked, or pairing reset). Retrying can't fix it;
 *  the user has to pair again. */
export function isAuthFailure(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("Authentication failed") ||
    message.includes("need to re-pair")
  );
}

/** True when a connect error needs the user to pair again. */
export function needsRepair(error: unknown): boolean {
  return isCertificateMismatch(error) || isAuthFailure(error);
}
