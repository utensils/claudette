import { useCallback } from "react";
import {
  loadDiffFiles,
  renameWorkspacePath,
  trashWorkspacePath,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type { FileContextTarget } from "./fileContextMenu";

export function useFilePathActions(workspaceId: string) {
  const renameFilePathInWorkspace = useAppStore(
    (s) => s.renameFilePathInWorkspace,
  );
  const removeFilePathFromWorkspace = useAppStore(
    (s) => s.removeFilePathFromWorkspace,
  );
  const requestFileTreeRefresh = useAppStore((s) => s.requestFileTreeRefresh);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const addToast = useAppStore((s) => s.addToast);

  const refreshWorkspaceFiles = useCallback(async () => {
    requestFileTreeRefresh(workspaceId);
    try {
      const result = await loadDiffFiles(workspaceId);
      if (useAppStore.getState().selectedWorkspaceId === workspaceId) {
        setDiffFiles(
          result.files,
          result.merge_base,
          result.staged_files,
          result.commits,
        );
      }
    } catch (err) {
      console.error("Failed to refresh diff after file operation:", err);
    }
  }, [requestFileTreeRefresh, setDiffFiles, workspaceId]);

  const renamePath = useCallback(
    async (target: FileContextTarget, newName: string) => {
      const result = await renameWorkspacePath(workspaceId, target.path, newName);
      renameFilePathInWorkspace(
        workspaceId,
        result.old_path,
        result.new_path,
        result.is_directory,
      );
      await refreshWorkspaceFiles();
      addToast("Renamed");
      return result;
    },
    [addToast, refreshWorkspaceFiles, renameFilePathInWorkspace, workspaceId],
  );

  const trashPath = useCallback(
    async (target: FileContextTarget) => {
      const result = await trashWorkspacePath(workspaceId, target.path);
      removeFilePathFromWorkspace(
        workspaceId,
        result.old_path,
        result.is_directory,
      );
      await refreshWorkspaceFiles();
      addToast("Moved to Trash");
      return result;
    },
    [addToast, refreshWorkspaceFiles, removeFilePathFromWorkspace, workspaceId],
  );

  return { renamePath, trashPath };
}
