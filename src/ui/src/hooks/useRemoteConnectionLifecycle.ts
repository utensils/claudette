import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/useAppStore";

/** Payload of the Rust-side `remote-connection-lost` event. */
interface RemoteConnectionLostPayload {
  connection_id: string;
}

/**
 * Keeps the store in sync with the Rust `RemoteConnectionManager` when a
 * remote connection drops unexpectedly (server restart, network loss).
 * Explicit disconnects don't emit this event — the caller already cleaned
 * up the store.
 */
export function useRemoteConnectionLifecycle() {
  const { t } = useTranslation("sidebar");

  useEffect(() => {
    const unlisten = listen<RemoteConnectionLostPayload>(
      "remote-connection-lost",
      (event) => {
        const id = event.payload.connection_id;
        const state = useAppStore.getState();
        if (!state.activeRemoteIds.includes(id)) return;
        const name =
          state.remoteConnections.find((c) => c.id === id)?.name ?? id;
        state.removeActiveRemoteId(id);
        state.clearRemoteData(id);
        state.addToast(t("remote_connection_lost", { name }));
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [t]);
}
