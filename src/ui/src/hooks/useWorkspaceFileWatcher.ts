import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import {
  readWorkspaceFileForViewer,
  unwatchWorkspaceFiles,
  watchWorkspaceFiles,
} from "../services/tauri";

interface WorkspaceFileChangedPayload {
  workspace_id: string;
  path: string;
}

/**
 * Wires the in-app file viewer into the backend's filesystem watcher so
 * external on-disk changes propagate into open buffers without manual
 * reloads.
 *
 * Three responsibilities:
 *   1. Subscribe a single global `workspace-file-changed` listener (the
 *      backend emits it from a `notify::RecommendedWatcher` callback).
 *   2. Re-assert the watched-path set whenever the active workspace's
 *      open file tabs change. The backend register API is idempotent
 *      and dedupes paths internally, so re-asserting on every list
 *      change is correct and cheap.
 *   3. Tear down a workspace's watches when the user navigates away
 *      from it, so we don't pay for OS-level watches on tabs the user
 *      can't see (the FilesPanel and Changes tabs already cover the
 *      "is the worktree alive?" lens at coarser cadence).
 *
 * Conflict policy (dirty buffer + external change) lives in the
 * `applyExternalFileChange` slice action — see its docstring for the
 * skip-and-flag rationale.
 */
export function useWorkspaceFileWatcher(): void {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const fileTabs = useAppStore((s) =>
    s.selectedWorkspaceId
      ? (s.fileTabsByWorkspace[s.selectedWorkspaceId] ?? null)
      : null,
  );
  const applyExternalFileChange = useAppStore(
    (s) => s.applyExternalFileChange,
  );

  // (1) Single global event listener. Mounted once for the lifetime of
  //     the hook host (AppLayout) so we don't churn listeners on every
  //     workspace switch — the dispatch logic below routes by workspace
  //     id.
  useEffect(() => {
    const unlisten = listen<WorkspaceFileChangedPayload>(
      "workspace-file-changed",
      async (event) => {
        const { workspace_id: workspaceId, path } = event.payload;
        // Re-read the file content. We deliberately don't trust the
        // event to carry content — the read goes through the same
        // `read_workspace_file_for_viewer` command that initial loads
        // use, so identical truncation / size-cap semantics apply and
        // we never have to reconcile two divergent code paths.
        try {
          const result = await readWorkspaceFileForViewer(workspaceId, path);
          // Snapshot the store at apply time. If the user closed the
          // tab between the event firing and the read finishing, the
          // slice action is a no-op for missing buffers — no work to
          // skip explicitly here.
          applyExternalFileChange(
            workspaceId,
            path,
            result.content ?? "",
            result.size_bytes,
            result.truncated,
          );
        } catch (err) {
          // A read failure most often means the file was deleted
          // between the event and our read — log at debug level and
          // let the FilesPanel's own polling notice the deletion at
          // the workspace-tree level.
          console.debug(
            "[file-watcher] re-read failed for",
            workspaceId,
            path,
            err,
          );
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyExternalFileChange]);

  // (2) + (3) Re-register on tab-list changes; clean up on workspace
  //     switch.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const workspaceId = selectedWorkspaceId;
    const paths = fileTabs ?? [];
    // Even an empty array is a meaningful instruction — it asks the
    // watcher to drop any prior subscriptions for this workspace.
    void watchWorkspaceFiles(workspaceId, paths).catch((err) => {
      console.debug("[file-watcher] register failed", err);
    });
    return () => {
      // Releasing on workspace switch is symmetric with the register;
      // the next workspace's effect installs only that workspace's
      // paths. The backend handles "no workspace currently active"
      // correctly (no-op).
      void unwatchWorkspaceFiles(workspaceId).catch((err) => {
        console.debug("[file-watcher] unregister failed", err);
      });
    };
  }, [selectedWorkspaceId, fileTabs]);
}
