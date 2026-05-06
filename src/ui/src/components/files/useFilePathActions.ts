import { useCallback } from "react";
import {
  createWorkspaceFile,
  loadDiffFiles,
  renameWorkspacePath,
  restoreWorkspacePathFromTrash,
  trashWorkspacePath,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import {
  snapshotRemovedFilePath,
  type FilePathUndoOperation,
} from "../../stores/slices/fileTreeSlice";
import type { FileContextTarget } from "./fileContextMenu";

export function useFilePathActions(workspaceId: string) {
  const renameFilePathInWorkspace = useAppStore(
    (s) => s.renameFilePathInWorkspace,
  );
  const openFileTab = useAppStore((s) => s.openFileTab);
  const setFileBufferLoaded = useAppStore((s) => s.setFileBufferLoaded);
  const removeFilePathFromWorkspace = useAppStore(
    (s) => s.removeFilePathFromWorkspace,
  );
  const requestFileTreeRefresh = useAppStore((s) => s.requestFileTreeRefresh);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const addToast = useAppStore((s) => s.addToast);
  const pushFilePathUndoOperation = useAppStore(
    (s) => s.pushFilePathUndoOperation,
  );
  const popFilePathUndoOperation = useAppStore((s) => s.popFilePathUndoOperation);

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
      pushFilePathUndoOperation(workspaceId, {
        kind: "rename",
        oldPath: result.old_path,
        newPath: result.new_path,
        isDirectory: result.is_directory,
      });
      await refreshWorkspaceFiles();
      addToast("Renamed");
      return result;
    },
    [
      addToast,
      pushFilePathUndoOperation,
      refreshWorkspaceFiles,
      renameFilePathInWorkspace,
      workspaceId,
    ],
  );

  const createFile = useCallback(
    async (parentPath: string, name: string) => {
      const result = await createWorkspaceFile(workspaceId, parentPath, name);
      openFileTab(workspaceId, result.path);
      setFileBufferLoaded(workspaceId, result.path, {
        baseline: "",
        isBinary: false,
        sizeBytes: 0,
        truncated: false,
        imageBytesB64: null,
      });
      pushFilePathUndoOperation(workspaceId, {
        kind: "create",
        path: result.path,
      });
      await refreshWorkspaceFiles();
      addToast("Created file");
      return result;
    },
    [
      addToast,
      openFileTab,
      pushFilePathUndoOperation,
      refreshWorkspaceFiles,
      setFileBufferLoaded,
      workspaceId,
    ],
  );

  const trashPath = useCallback(
    async (target: FileContextTarget) => {
      const snapshot = snapshotRemovedFilePath(
        useAppStore.getState(),
        workspaceId,
        target.path,
        target.isDirectory,
      );
      const result = await trashWorkspacePath(workspaceId, target.path);
      removeFilePathFromWorkspace(
        workspaceId,
        result.old_path,
        result.is_directory,
      );
      pushFilePathUndoOperation(workspaceId, {
        kind: "trash",
        oldPath: result.old_path,
        isDirectory: result.is_directory,
        undoToken: result.undo_token,
        snapshot,
      });
      await refreshWorkspaceFiles();
      addToast("Moved to Trash");
      return result;
    },
    [
      addToast,
      pushFilePathUndoOperation,
      refreshWorkspaceFiles,
      removeFilePathFromWorkspace,
      workspaceId,
    ],
  );

  const undoLastFilePathOperation = useCallback(async (): Promise<boolean> => {
    const stack =
      useAppStore.getState().filePathUndoStackByWorkspace[workspaceId] ?? [];
    const operation = stack.at(-1);
    if (!operation) {
      addToast("Nothing to undo");
      return false;
    }

    try {
      await runUndoFilePathOperation(workspaceId, operation);
      popFilePathUndoOperation(workspaceId);
      await refreshWorkspaceFiles();
      addToast("Undone");
      return true;
    } catch (err) {
      console.error("Failed to undo file operation:", err);
      addToast(`Undo failed: ${String(err)}`);
      return false;
    }
  }, [
    addToast,
    popFilePathUndoOperation,
    refreshWorkspaceFiles,
    workspaceId,
  ]);

  return { createFile, renamePath, trashPath, undoLastFilePathOperation };
}

async function runUndoFilePathOperation(
  workspaceId: string,
  operation: FilePathUndoOperation,
): Promise<void> {
  if (operation.kind === "create") {
    const result = await trashWorkspacePath(workspaceId, operation.path);
    useAppStore
      .getState()
      .removeFilePathFromWorkspace(
        workspaceId,
        result.old_path,
        result.is_directory,
      );
    return;
  }

  if (operation.kind === "rename") {
    // The backend rename command currently accepts names only, not paths, so
    // undo can restore the old sibling name without storing a full move target.
    const oldName = operation.oldPath.split("/").pop() ?? operation.oldPath;
    if (oldName.includes("/") || oldName.includes("\\")) {
      throw new Error("Cannot undo rename with a nested target name");
    }
    const result = await renameWorkspacePath(
      workspaceId,
      operation.newPath,
      oldName,
    );
    useAppStore
      .getState()
      .renameFilePathInWorkspace(
        workspaceId,
        result.old_path,
        result.new_path,
        result.is_directory,
      );
    return;
  }

  await restoreWorkspacePathFromTrash(
    workspaceId,
    operation.oldPath,
    operation.undoToken,
  );
  useAppStore
    .getState()
    .restoreRemovedFilePathInWorkspace(workspaceId, operation.snapshot);
}
