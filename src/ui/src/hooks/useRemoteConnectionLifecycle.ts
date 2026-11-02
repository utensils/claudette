import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  listActiveRemoteConnections,
  listRemoteConnections,
} from "../services/tauri";
import { useAppStore } from "../stores/useAppStore";
import {
  connectRemoteConnection,
  dropConnectionState,
  isCertificateMismatch,
  needsRepair,
  resyncActiveConnection,
  wasDisconnectedByUser,
} from "../components/sidebar/remoteConnectionActions";

/** Payload of the Rust-side `remote-connection-lost` and
 *  `remote-events-lost` events. */
interface RemoteConnectionLostPayload {
  connection_id: string;
}

/** Backoff between automatic connect attempts; the last value repeats. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function connectionName(id: string): string {
  return (
    useAppStore.getState().remoteConnections.find((c) => c.id === id)?.name ??
    id
  );
}

/** Cancel a pending reconnect for `id` (if any). */
export function stopReconnecting(id: string): void {
  const timer = pending.get(id);
  if (timer) clearTimeout(timer);
  pending.delete(id);
  useAppStore.getState().setRemoteReconnecting(id, false);
}

/**
 * Keep trying to connect `id` with backoff until it succeeds, the user
 * cancels, disconnects or removes it, or the server needs the user to pair
 * again (its certificate changed, or it no longer accepts this device).
 */
export function scheduleReconnect(
  id: string,
  t: TFunction<"sidebar">,
  { announce, attempt = 0 }: { announce: boolean; attempt?: number },
): void {
  if (pending.has(id)) return;
  useAppStore.getState().setRemoteReconnecting(id, true);
  const delay =
    RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  pending.set(
    id,
    setTimeout(async () => {
      pending.delete(id);
      const state = useAppStore.getState();
      const stillSaved = state.remoteConnections.some((c) => c.id === id);
      if (
        !stillSaved ||
        wasDisconnectedByUser(id) ||
        state.activeRemoteIds.includes(id)
      ) {
        stopReconnecting(id);
        return;
      }
      try {
        const adopted = await connectRemoteConnection(id);
        stopReconnecting(id);
        if (adopted && announce) {
          state.addToast(t("remote_reconnected", { name: connectionName(id) }));
        }
      } catch (e) {
        if (needsRepair(e)) {
          stopReconnecting(id);
          const key = isCertificateMismatch(e)
            ? "remote_certificate_changed"
            : "remote_needs_repair";
          state.addToast(t(key, { name: connectionName(id) }));
          return;
        }
        scheduleReconnect(id, t, { announce, attempt: attempt + 1 });
      }
    }, delay),
  );
}

/**
 * App-level remote connection lifecycle:
 * - on launch (or webview reload), re-adopt connections the Rust side
 *   still holds and auto-connect saved servers marked `auto_connect`;
 * - when a connection drops unexpectedly, clear its live state and keep
 *   reconnecting in the background;
 * - when a live connection loses events, resync it.
 */
export function useRemoteConnectionLifecycle() {
  const { t } = useTranslation("sidebar");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [saved, active] = await Promise.all([
          listRemoteConnections(),
          listActiveRemoteConnections(),
        ]);
        if (cancelled) return;
        useAppStore.getState().setRemoteConnections(saved);
        for (const id of active) {
          resyncActiveConnection(id).catch((e) =>
            console.error("Failed to resync remote connection:", e),
          );
        }
        for (const conn of saved) {
          if (conn.auto_connect && !active.includes(conn.id)) {
            scheduleReconnect(conn.id, t, { announce: false });
          }
        }
      } catch (e) {
        console.error("Failed to load remote connections:", e);
      }
    })();

    const unlisten = listen<RemoteConnectionLostPayload>(
      "remote-connection-lost",
      (event) => {
        const id = event.payload.connection_id;
        const state = useAppStore.getState();
        if (!state.activeRemoteIds.includes(id)) return;
        dropConnectionState(id);
        state.addToast(t("remote_connection_lost", { name: connectionName(id) }));
        scheduleReconnect(id, t, { announce: true });
      },
    );
    // Some of a live connection's events were lost (it fell behind):
    // reload its workspaces and recover pending approvals.
    const unlistenLost = listen<RemoteConnectionLostPayload>(
      "remote-events-lost",
      (event) => {
        const id = event.payload.connection_id;
        if (!useAppStore.getState().activeRemoteIds.includes(id)) return;
        resyncActiveConnection(id).catch((e) =>
          console.error("Failed to resync remote connection:", e),
        );
      },
    );
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
      void unlistenLost.then((fn) => fn());
      for (const id of [...pending.keys()]) stopReconnecting(id);
    };
  }, [t]);
}
