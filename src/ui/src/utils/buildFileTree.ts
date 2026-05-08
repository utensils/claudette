import type { FileEntry } from "../services/tauri";
import type { FileStatus, GitFileLayer } from "../types/diff";

export type FileTreeNode =
  | {
      kind: "dir";
      /** Full path including trailing slash, e.g. `src/components/`. */
      path: string;
      name: string;
      statusCount: number;
      /** Dominant status across descendants for tinting. Modified wins over
       *  Deleted, Renamed, then Added — see `folderStatusPriority`. */
      folderStatus: FileStatus | null;
      children: FileTreeNode[];
    }
  | {
      kind: "file";
      /** Full relative path, e.g. `src/components/Button.tsx`. */
      path: string;
      name: string;
      git_status: FileStatus | null;
      git_layer: GitFileLayer | null;
    };

/** Build a hierarchical tree from the flat `FileEntry[]` returned by
 *  `list_workspace_files`. Folders come first at each level, then files,
 *  alphabetical within each group. Directories are derived from file
 *  paths — `is_directory: true` entries from the backend are ignored
 *  because git doesn't track empty directories anyway. */
export function buildFileTree(entries: FileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirNodes = new Map<string, FileTreeNode & { kind: "dir" }>();

  for (const entry of entries) {
    if (entry.is_directory) continue;
    const parts = entry.path.split("/");
    if (parts.length === 0 || parts[0] === "") continue;
    const fileName = parts[parts.length - 1];

    let currentChildren = root;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i];
      currentPath += segment + "/";
      let dir = dirNodes.get(currentPath);
      if (!dir) {
        dir = {
          kind: "dir",
          path: currentPath,
          name: segment,
          statusCount: 0,
          folderStatus: null,
          children: [],
        };
        dirNodes.set(currentPath, dir);
        currentChildren.push(dir);
      }
      currentChildren = dir.children;
    }
    currentChildren.push({
      kind: "file",
      path: entry.path,
      name: fileName,
      git_status: entry.git_status ?? null,
      git_layer: entry.git_layer ?? null,
    });
  }

  aggregateFolders(root);
  sortNodes(root);
  return root;
}

interface FolderAggregate {
  count: number;
  dominant: FileStatus | null;
}

/** Post-order walk: each dir absorbs its children's count and the highest-
 *  priority status seen below it. Modified outranks Deleted, Renamed, then
 *  Added so a folder containing a single edit doesn't read as "added" just
 *  because its sibling files were also new. */
function aggregateFolders(nodes: FileTreeNode[]): FolderAggregate {
  const result: FolderAggregate = { count: 0, dominant: null };
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.git_status) {
        result.count += 1;
        result.dominant = pickHigherStatus(result.dominant, node.git_status);
      }
    } else {
      const child = aggregateFolders(node.children);
      node.statusCount = child.count;
      node.folderStatus = child.dominant;
      result.count += child.count;
      result.dominant = pickHigherStatus(result.dominant, child.dominant);
    }
  }
  return result;
}

function pickHigherStatus(
  a: FileStatus | null,
  b: FileStatus | null,
): FileStatus | null {
  if (a == null) return b;
  if (b == null) return a;
  return folderStatusPriority(b) > folderStatusPriority(a) ? b : a;
}

function folderStatusPriority(status: FileStatus): number {
  if (status === "Modified") return 4;
  if (status === "Deleted") return 3;
  if (typeof status !== "string") return 2; // Renamed
  return 1; // Added (covers untracked too — layer is per-file, not per-folder)
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) {
    if (n.kind === "dir") sortNodes(n.children);
  }
}

/** Flatten the tree into a list of currently-visible rows, respecting
 *  the `expanded` set. Used by keyboard navigation to compute next/prev
 *  rows in O(n) without recursing through the tree on every keystroke. */
export function flattenVisible(
  nodes: FileTreeNode[],
  expanded: Record<string, boolean>,
  depth = 0,
  out: { node: FileTreeNode; depth: number }[] = [],
): { node: FileTreeNode; depth: number }[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && expanded[node.path]) {
      flattenVisible(node.children, expanded, depth + 1, out);
    }
  }
  return out;
}
