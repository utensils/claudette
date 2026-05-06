import type { FileTreeNode } from "../../utils/buildFileTree";
import type {
  DiffFile,
  DiffLayer,
  FileStatus,
  GitFileLayer,
  StagedDiffFiles,
} from "../../types/diff";

export type FileTreeActivation =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; layer: DiffLayer | null };

export function statusLabel(
  status: FileStatus,
  layer: GitFileLayer | null = null,
): string {
  if (typeof status === "string") {
    switch (status) {
      case "Added":
        return layer === "untracked" ? "U" : "A";
      case "Modified":
        return "M";
      case "Deleted":
        return "D";
      default:
        return assertNever(status);
    }
  }
  return "R";
}

export function statusColor(status: FileStatus): string {
  if (typeof status === "string") {
    return status === "Added"
      ? "var(--diff-added-text)"
      : status === "Modified"
        ? "var(--tool-task)"
        : "var(--diff-removed-text)";
  }
  return "var(--diff-hunk-header)";
}

export function statusLayerForOpenFileTab(
  path: string,
  stagedFiles: StagedDiffFiles | null,
): GitFileLayer | null {
  if (!stagedFiles) return null;
  if (stagedFiles.untracked.some((file) => file.path === path)) {
    return "untracked";
  }
  if (stagedFiles.staged.some((file) => file.path === path)) {
    return "staged";
  }
  if (stagedFiles.unstaged.some((file) => file.path === path)) {
    return "unstaged";
  }
  return null;
}

function diffLayerForGitLayer(layer: GitFileLayer | null): DiffLayer | null {
  if (layer === "staged" || layer === "unstaged" || layer === "untracked") {
    return layer;
  }
  if (layer === "mixed") return "unstaged";
  return null;
}

export function resolveFileTreeActivation(
  node: FileTreeNode & { kind: "file" },
): FileTreeActivation {
  if (node.git_status === "Deleted") {
    return {
      kind: "diff",
      path: node.path,
      layer: diffLayerForGitLayer(node.git_layer),
    };
  }
  return { kind: "file", path: node.path };
}

export function statusForOpenFileTab(
  path: string,
  stagedFiles: StagedDiffFiles | null,
): FileStatus | null {
  if (!stagedFiles) return null;
  const matches = [
    ...stagedFiles.staged,
    ...stagedFiles.unstaged,
    ...stagedFiles.untracked,
  ].filter((file) => file.path === path);
  if (matches.length === 0) return null;
  return combineFileStatuses(matches);
}

function combineFileStatuses(files: DiffFile[]): FileStatus {
  const deleted = files.find((file) => file.status === "Deleted");
  if (deleted) return deleted.status;
  const added = files.find((file) => file.status === "Added");
  if (added) return added.status;
  const renamed = files.find((file) => typeof file.status !== "string");
  if (renamed) return renamed.status;
  return "Modified";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled file status: ${value}`);
}
