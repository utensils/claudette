import { useCallback, useMemo, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import {
  loadDiffFiles,
  openWorkspacePath,
  renameWorkspacePath,
  resolveWorkspacePath,
  revealWorkspacePath,
  trashWorkspacePath,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { pathMatchesTarget } from "../../stores/slices/fileTreeSlice";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { DeletePathConfirm } from "./DeletePathConfirm";
import { RenamePathDialog } from "./RenamePathDialog";
import {
  buildFileContextMenuItems,
  type FileContextTarget,
} from "./fileContextMenu";

interface FilePathContextMenuProps {
  workspaceId: string;
  target: FileContextTarget;
  x: number;
  y: number;
  beforeItems?: ContextMenuItem[];
  onClose: () => void;
}

function countDirtyAffectedFiles(
  workspaceId: string,
  target: FileContextTarget,
): number {
  const state = useAppStore.getState();
  const prefix = `${workspaceId}:`;
  let count = 0;
  for (const [key, buffer] of Object.entries(state.fileBuffers)) {
    if (!key.startsWith(prefix)) continue;
    if (buffer.buffer === buffer.baseline) continue;
    const path = key.slice(prefix.length);
    if (pathMatchesTarget(path, target.path, target.isDirectory)) count += 1;
  }
  return count;
}

export function FilePathContextMenu({
  workspaceId,
  target,
  x,
  y,
  beforeItems,
  onClose,
}: FilePathContextMenuProps) {
  const openFileTab = useAppStore((s) => s.openFileTab);
  const renameFilePathInWorkspace = useAppStore((s) => s.renameFilePathInWorkspace);
  const removeFilePathFromWorkspace = useAppStore((s) => s.removeFilePathFromWorkspace);
  const requestFileTreeRefresh = useAppStore((s) => s.requestFileTreeRefresh);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const addToast = useAppStore((s) => s.addToast);
  const [renameTarget, setRenameTarget] = useState<FileContextTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileContextTarget | null>(null);
  const [menuVisible, setMenuVisible] = useState(true);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);

  const refreshWorkspaceFiles = useCallback(async () => {
    requestFileTreeRefresh(workspaceId);
    try {
      const result = await loadDiffFiles(workspaceId);
      if (useAppStore.getState().selectedWorkspaceId === workspaceId) {
        setDiffFiles(result.files, result.merge_base, result.staged_files, result.commits);
      }
    } catch (err) {
      console.error("Failed to refresh diff after file operation:", err);
    }
  }, [requestFileTreeRefresh, setDiffFiles, workspaceId]);

  const dirtyCount = useMemo(
    () =>
      renameTarget
        ? countDirtyAffectedFiles(workspaceId, renameTarget)
        : deleteTarget
          ? countDirtyAffectedFiles(workspaceId, deleteTarget)
          : 0,
    [deleteTarget, renameTarget, workspaceId],
  );

  const items = useMemo<ContextMenuItem[]>(() => {
    const fileItems = buildFileContextMenuItems(target, {
      open: () => {
        if (target.isDirectory) {
          return openWorkspacePath(workspaceId, target.path);
        }
        openFileTab(workspaceId, target.path);
      },
      reveal: () => revealWorkspacePath(workspaceId, target.path),
      copyPath: async () => {
        const absolute = await resolveWorkspacePath(workspaceId, target.path);
        await clipboardWriteText(absolute);
        addToast("Copied path");
      },
      copyRelativePath: async () => {
        await clipboardWriteText(target.path.replace(/\/+$/g, ""));
        addToast("Copied relative path");
      },
      rename: () => {
        setOperationError(null);
        setMenuVisible(false);
        setRenameTarget(target);
      },
      delete: () => {
        setOperationError(null);
        setMenuVisible(false);
        setDeleteTarget(target);
      },
    });
    if (!beforeItems || beforeItems.length === 0) return fileItems;
    return [...beforeItems, { type: "separator" }, ...fileItems];
  }, [addToast, beforeItems, openFileTab, target, workspaceId]);

  const handleRename = async (name: string) => {
    if (!renameTarget) return;
    setOperationLoading(true);
    setOperationError(null);
    try {
      const result = await renameWorkspacePath(workspaceId, renameTarget.path, name);
      renameFilePathInWorkspace(
        workspaceId,
        result.old_path,
        result.new_path,
        result.is_directory,
      );
      await refreshWorkspaceFiles();
      addToast("Renamed");
      setRenameTarget(null);
      onClose();
    } catch (err) {
      setOperationError(String(err));
    } finally {
      setOperationLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setOperationLoading(true);
    setOperationError(null);
    try {
      const result = await trashWorkspacePath(workspaceId, deleteTarget.path);
      removeFilePathFromWorkspace(workspaceId, result.old_path, result.is_directory);
      await refreshWorkspaceFiles();
      addToast("Moved to Trash");
      setDeleteTarget(null);
      onClose();
    } catch (err) {
      setOperationError(String(err));
    } finally {
      setOperationLoading(false);
    }
  };

  return (
    <>
      {menuVisible && (
        <ContextMenu
          x={x}
          y={y}
          items={items}
          onClose={onClose}
          dataTestId="file-context-menu"
        />
      )}
      {renameTarget && (
        <RenamePathDialog
          target={renameTarget}
          dirtyCount={dirtyCount}
          loading={operationLoading}
          error={operationError}
          onConfirm={handleRename}
          onClose={() => {
            if (operationLoading) return;
            setRenameTarget(null);
            setOperationError(null);
            onClose();
          }}
        />
      )}
      {deleteTarget && (
        <DeletePathConfirm
          target={deleteTarget}
          dirtyCount={dirtyCount}
          loading={operationLoading}
          error={operationError}
          onConfirm={handleDelete}
          onClose={() => {
            if (operationLoading) return;
            setDeleteTarget(null);
            setOperationError(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
