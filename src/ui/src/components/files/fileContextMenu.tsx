import {
  Copy,
  ExternalLink,
  FilePlus,
  FilePenLine,
  FolderOpen,
  Trash2,
} from "lucide-react";
import type { ContextMenuItem } from "../shared/ContextMenu";

export interface FileContextTarget {
  path: string;
  isDirectory: boolean;
  exists: boolean;
}

export interface FileContextMenuCallbacks {
  newFile?: () => void;
  open: () => void | Promise<void>;
  reveal: () => void | Promise<void>;
  copyPath: () => void | Promise<void>;
  copyRelativePath: () => void | Promise<void>;
  rename: () => void;
  delete: () => void;
}

export function displayNameForPath(path: string): string {
  const stripped = path.replace(/\/+$/g, "");
  return stripped.split("/").pop() || stripped || path;
}

export function validatePathName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (trimmed.includes("\0")) return "Name cannot contain null bytes.";
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "Name cannot contain path separators.";
  }
  return null;
}

export function buildFileContextMenuItems(
  target: FileContextTarget,
  callbacks: FileContextMenuCallbacks,
): ContextMenuItem[] {
  const missing = !target.exists;
  return [
    ...(callbacks.newFile
      ? [
          {
            label: "New File",
            icon: <FilePlus size={14} aria-hidden="true" />,
            onSelect: callbacks.newFile,
            closeOnSelect: false,
          } satisfies ContextMenuItem,
          { type: "separator" } satisfies ContextMenuItem,
        ]
      : []),
    {
      label: target.isDirectory ? "Open Folder" : "Open",
      icon: <ExternalLink size={14} aria-hidden="true" />,
      onSelect: callbacks.open,
      disabled: missing,
    },
    {
      label: "Reveal in Finder",
      icon: <FolderOpen size={14} aria-hidden="true" />,
      onSelect: callbacks.reveal,
      disabled: missing,
    },
    { type: "separator" },
    {
      label: "Copy Path",
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyPath,
      disabled: missing,
    },
    {
      label: "Copy Relative Path",
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyRelativePath,
    },
    { type: "separator" },
    {
      label: "Rename…",
      icon: <FilePenLine size={14} aria-hidden="true" />,
      onSelect: callbacks.rename,
      disabled: missing,
      closeOnSelect: false,
    },
    {
      label: "Delete",
      icon: <Trash2 size={14} aria-hidden="true" />,
      onSelect: callbacks.delete,
      disabled: missing,
      variant: "danger",
      closeOnSelect: false,
    },
  ];
}
