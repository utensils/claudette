import type { FileTreeNode } from "../../utils/buildFileTree";
import type { DiffLayer, FileStatus, GitFileLayer } from "../../types/diff";

export type FileTreeActivation =
  | { kind: "file"; path: string }
  | { kind: "diff"; path: string; layer: DiffLayer | null };

export function statusLabel(status: FileStatus): string {
  if (typeof status === "string") {
    return status === "Added" ? "A" : status === "Modified" ? "M" : "D";
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
