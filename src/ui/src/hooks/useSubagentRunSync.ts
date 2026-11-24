import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { selectActiveSessionId, useAppStore } from "../stores/useAppStore";
import type { SubagentRun } from "../types/subagent";

interface RemoteSource {
  remote_connection_id?: string;
}

/** Subscribe before reading the snapshot. Late events for inactive sessions
 * remain observable across navigation and after the launching turn finishes. */
export function useSubagentRunSync() {
  const [ready, setReady] = useState(false);
  const sessionId = useAppStore(selectActiveSessionId);
  const connectionId = useAppStore((s) =>
    s.workspaces.find((ws) => ws.id === s.selectedWorkspaceId)?.remote_connection_id,
  );
  const connected = useAppStore((s) => !connectionId || s.activeRemoteIds.includes(connectionId));
  useEffect(() => {
    let disposed = false;
    const store = useAppStore.getState();
    const listeners = [
      listen<SubagentRun & RemoteSource>("subagent-run-updated", ({ payload }) => {
        if (!disposed) store.mergeSubagentRuns(payload.remote_connection_id ?? null, [payload]);
      }),
      listen<{ session_id: string } & RemoteSource>("subagent-runs-invalidated", ({ payload }) => {
        if (!disposed) void store.reloadSubagentRuns(payload.remote_connection_id ?? null, payload.session_id, true);
      }),
      listen<{ connection_id: string }>("remote-events-lost", ({ payload }) => {
        if (disposed) return;
        const s = useAppStore.getState();
        const selected = s.workspaces.find((ws) => ws.id === s.selectedWorkspaceId);
        if (selected?.remote_connection_id !== payload.connection_id) return;
        for (const session of s.sessionsByWorkspace[selected.id] ?? []) {
          void store.reloadSubagentRuns(payload.connection_id, session.id);
        }
      }),
    ];
    void Promise.all(listeners).then(() => {
      if (!disposed) setReady(true);
    });
    return () => {
      disposed = true;
      for (const listener of listeners) void listener.then((unlisten) => unlisten());
    };
  }, []);
  useEffect(() => {
    if (ready && sessionId && connectionId !== undefined && connected) {
      void useAppStore.getState().reloadSubagentRuns(connectionId, sessionId);
    }
  }, [ready, sessionId, connectionId, connected]);
}
