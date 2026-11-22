import {
  Copy,
  ExternalLink,
  FilePlus,
  FilePenLine,
  FolderOpen,
  Trash2,
} from "lucide-react";
import i18n from "../../i18n";
import type { ContextMenuItem } from "../shared/ContextMenu";

export interface FileContextTarget {
  path: string;
  isDirectory: boolean;
  exists: boolean;
}

export interface FileContextMenuCallbacks {
  newFile?: () => void;
  newFileShortcut?: string;
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
  if (!trimmed) return i18n.t("modals:files_name_required");
  if (trimmed === "." || trimmed === "..") return i18n.t("modals:files_name_reserved");
  if (trimmed.includes("\0")) return i18n.t("modals:files_name_null_bytes");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return i18n.t("modals:files_name_separators");
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
            label: i18n.t("modals:files_menu_new_file"),
            icon: <FilePlus size={14} aria-hidden="true" />,
            shortcut: callbacks.newFileShortcut,
            onSelect: callbacks.newFile,
            closeOnSelect: false,
          } satisfies ContextMenuItem,
          { type: "separator" } satisfies ContextMenuItem,
        ]
      : []),
    {
      label: target.isDirectory
        ? i18n.t("modals:files_menu_open_folder")
        : i18n.t("modals:files_menu_open"),
      icon: <ExternalLink size={14} aria-hidden="true" />,
      onSelect: callbacks.open,
      disabled: missing,
    },
    {
      label: i18n.t("modals:files_menu_reveal"),
      icon: <FolderOpen size={14} aria-hidden="true" />,
      onSelect: callbacks.reveal,
      disabled: missing,
    },
    { type: "separator" },
    {
      label: i18n.t("modals:files_menu_copy_path"),
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyPath,
      disabled: missing,
    },
    {
      label: i18n.t("modals:files_menu_copy_relative_path"),
      icon: <Copy size={14} aria-hidden="true" />,
      onSelect: callbacks.copyRelativePath,
    },
    { type: "separator" },
    {
      label: i18n.t("modals:files_menu_rename"),
      icon: <FilePenLine size={14} aria-hidden="true" />,
      onSelect: callbacks.rename,
      disabled: missing,
      closeOnSelect: false,
    },
    {
      label: i18n.t("modals:files_menu_delete"),
      icon: <Trash2 size={14} aria-hidden="true" />,
      onSelect: callbacks.delete,
      disabled: missing,
      variant: "danger",
      closeOnSelect: false,
    },
  ];
}
