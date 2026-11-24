import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSubagentRuns } from "../services/tauri/subagentRuns";
import { selectActiveSessionId, useAppStore } from "../stores/useAppStore";
import type { SubagentRun } from "../types/subagent";

/** Subscribe before reading the snapshot, including after remote reconnection.
 *  No handler depends on whether the parent's turn is still active. */
export function useSubagentRunSync() {
  const sessionId = useAppStore(selectActiveSessionId);
  const connectionId = useAppStore((s) =>
    s.workspaces.find((ws) => ws.id === s.selectedWorkspaceId)?.remote_connection_id,
  );
  const connected = useAppStore((s) => !connectionId || s.activeRemoteIds.includes(connectionId));
  useEffect(() => {
    let disposed = false;
    const merge = useAppStore.getState().mergeSubagentRuns;
    const reload = async () => {
      if (disposed || !sessionId || connectionId === undefined || !connected) return;
      try {
        const rows = await getSubagentRuns(sessionId, connectionId);
        if (!disposed && Array.isArray(rows)) merge(connectionId, rows);
      } catch (err) {
        // Older paired hosts can still render Agent activities from checkpoints.
        console.debug("Subagent run history unavailable", err);
      }
    };
    const listeners = [
      listen<SubagentRun & { remote_connection_id?: string }>("subagent-run-updated", ({ payload }) => {
        if (!disposed) merge(payload.remote_connection_id ?? null, [payload]);
      }),
      listen<{ connection_id: string }>("remote-events-lost", ({ payload }) => {
        if (payload.connection_id === connectionId) void reload();
      }),
    ];
    void Promise.all(listeners).then(reload);
    return () => {
      disposed = true;
      for (const listener of listeners) void listener.then((unlisten) => unlisten());
    };
  }, [sessionId, connectionId, connected]);
}
