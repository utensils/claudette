import {
  Archive,
  Copy,
  FolderOpen,
  Mail,
  Pencil,
  RotateCcw,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ContextMenuItem } from "../shared/ContextMenu";
import type { WorkspaceStatus } from "../../types/workspace";

export interface WorkspaceContextMenuLabels {
  renameWorkspace: string;
  markAsUnread: string;
  openInFileManager: string;
  openInTerminal: string;
  copyWorkingDirectory: string;
  copyClaudeSessionId: string;
  archiveWorkspace: string;
  restoreWorkspace: string;
  deleteWorkspace: string;
}

export interface WorkspaceContextMenuTarget {
  status: WorkspaceStatus;
  worktreePath: string | null;
  remote: boolean;
}

export interface WorkspaceContextMenuCallbacks {
  rename?: () => void;
  markAsUnread: () => void;
  openInFileManager?: () => void | Promise<void>;
  openInTerminal?: () => void | Promise<void>;
  copyWorkingDirectory?: () => void | Promise<void>;
  copyClaudeSessionId?: () => void | Promise<void>;
  archive?: () => void | Promise<void>;
  restore?: () => void | Promise<void>;
  delete?: () => void | Promise<void>;
}

export function buildWorkspaceContextMenuItems(
  target: WorkspaceContextMenuTarget,
  labels: WorkspaceContextMenuLabels,
  callbacks: WorkspaceContextMenuCallbacks,
): ContextMenuItem[] {
  if (target.remote) {
    const items: ContextMenuItem[] = [
      {
        label: labels.markAsUnread,
        icon: <Mail size={14} aria-hidden="true" />,
        onSelect: callbacks.markAsUnread,
      },
    ];
    if (target.status === "Active" && callbacks.archive) {
      items.push({ type: "separator" });
      items.push({
        label: labels.archiveWorkspace,
        icon: <Archive size={14} aria-hidden="true" />,
        onSelect: callbacks.archive,
      });
    }
    return items;
  }

  const hasWorktree = target.worktreePath !== null;
  return [
    {
      label: labels.renameWorkspace,
      icon: <Pencil size={14} aria-hidden="true" />,
      onSelect: callbacks.rename ?? (() => {}),
      disabled: !callbacks.rename,
    },
    {
      label: labels.markAsUnread,
      icon: <Mail size={14} aria-hidden="true" />,
      onSelect: callbacks.markAsUnread,
    },
    { type: "separator" },
    {
      label: labels.openInFileManager,
      icon: <FolderOpen size={14} aria-hidden="true" />,
      onSelect: callbacks.openInFileManager ?? (() => {}),
      disabled: !hasWorktree || !callbacks.openInFileManager,
    },
    {
      label: labels.openInTerminal,
      icon: <Terminal size={14} aria-hidden="true" />,
      onSelect: callbacks.openInTerminal ?? (() => {}),
      disabled: !hasWorktree || !callbacks.openInTerminal,
    },
    {
      label: labels.copyWorkingDirectory,
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyWorkingDirectory ?? (() => {}),
      disabled: !hasWorktree || !callbacks.copyWorkingDirectory,
    },
    {
      label: labels.copyClaudeSessionId,
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyClaudeSessionId ?? (() => {}),
      disabled: !callbacks.copyClaudeSessionId,
    },
    { type: "separator" },
    ...(target.status === "Active"
      ? [
          {
            label: labels.archiveWorkspace,
            icon: <Archive size={14} aria-hidden="true" />,
            onSelect: callbacks.archive ?? (() => {}),
            disabled: !callbacks.archive,
          } satisfies ContextMenuItem,
        ]
      : [
          {
            label: labels.restoreWorkspace,
            icon: <RotateCcw size={14} aria-hidden="true" />,
            onSelect: callbacks.restore ?? (() => {}),
            disabled: !callbacks.restore,
          } satisfies ContextMenuItem,
          {
            label: labels.deleteWorkspace,
            icon: <Trash2 size={14} aria-hidden="true" />,
            onSelect: callbacks.delete ?? (() => {}),
            disabled: !callbacks.delete,
            variant: "danger",
          } satisfies ContextMenuItem,
        ]),
  ];
}
