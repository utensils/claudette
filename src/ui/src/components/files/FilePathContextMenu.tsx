import { useMemo, useState } from "react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import {
  openWorkspacePath,
  resolveWorkspacePath,
  revealWorkspacePath,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { pathMatchesTarget } from "../../stores/slices/fileTreeSlice";
import { ContextMenu, type ContextMenuItem } from "../shared/ContextMenu";
import { DeletePathConfirm } from "./DeletePathConfirm";
import {
  buildFileContextMenuItems,
  type FileContextTarget,
} from "./fileContextMenu";
import { useFilePathActions } from "./useFilePathActions";

interface FilePathContextMenuProps {
  workspaceId: string;
  target: FileContextTarget;
  x: number;
  y: number;
  beforeItems?: ContextMenuItem[];
  onCreateFileRequest?: (parentPath: string) => void;
  onRenameRequest: (target: FileContextTarget) => void;
  onOperationComplete?: () => void;
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
  onCreateFileRequest,
  onRenameRequest,
  onOperationComplete,
  onClose,
}: FilePathContextMenuProps) {
  const openFileTab = useAppStore((s) => s.openFileTab);
  const addToast = useAppStore((s) => s.addToast);
  const { trashPath } = useFilePathActions(workspaceId);
  const [deleteTarget, setDeleteTarget] = useState<FileContextTarget | null>(null);
  const [menuVisible, setMenuVisible] = useState(true);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);

  const dirtyCount = useMemo(
    () =>
      deleteTarget ? countDirtyAffectedFiles(workspaceId, deleteTarget) : 0,
    [deleteTarget, workspaceId],
  );

  const items = useMemo<ContextMenuItem[]>(() => {
    const fileItems = buildFileContextMenuItems(target, {
      newFile: onCreateFileRequest
        ? () => {
            setOperationError(null);
            onCreateFileRequest(parentPathForNewFile(target));
            onClose();
          }
        : undefined,
      open: () => {
        if (target.isDirectory) {
          return openWorkspacePath(workspaceId, target.path).finally(() =>
            onOperationComplete?.(),
          );
        }
        openFileTab(workspaceId, target.path);
        onOperationComplete?.();
      },
      reveal: () =>
        revealWorkspacePath(workspaceId, target.path).finally(() =>
          onOperationComplete?.(),
        ),
      copyPath: async () => {
        const absolute = await resolveWorkspacePath(workspaceId, target.path);
        await clipboardWriteText(absolute);
        addToast("Copied path");
        onOperationComplete?.();
      },
      copyRelativePath: async () => {
        await clipboardWriteText(target.path.replace(/\/+$/g, ""));
        addToast("Copied relative path");
        onOperationComplete?.();
      },
      rename: () => {
        setOperationError(null);
        onRenameRequest(target);
        onClose();
      },
      delete: () => {
        setOperationError(null);
        setMenuVisible(false);
        setDeleteTarget(target);
      },
    });
    if (!beforeItems || beforeItems.length === 0) return fileItems;
    return [...beforeItems, { type: "separator" }, ...fileItems];
  }, [
    addToast,
    beforeItems,
    onClose,
    onCreateFileRequest,
    onOperationComplete,
    onRenameRequest,
    openFileTab,
    target,
    workspaceId,
  ]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setOperationLoading(true);
    setOperationError(null);
    try {
      await trashPath(deleteTarget);
      setDeleteTarget(null);
      onClose();
      onOperationComplete?.();
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
            onOperationComplete?.();
          }}
        />
      )}
    </>
  );
}

function parentPathForNewFile(target: FileContextTarget): string {
  const clean = target.path.replace(/\/+$/g, "");
  if (target.isDirectory) return clean;
  const slash = clean.lastIndexOf("/");
  return slash === -1 ? "" : clean.slice(0, slash);
}
