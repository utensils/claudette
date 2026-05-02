import type { FileEntry } from "../services/tauri";

export type FileTreeNode =
  | {
      kind: "dir";
      /** Full path including trailing slash, e.g. `src/components/`. */
      path: string;
      name: string;
      children: FileTreeNode[];
    }
  | {
      kind: "file";
      /** Full relative path, e.g. `src/components/Button.tsx`. */
      path: string;
      name: string;
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
          children: [],
        };
        dirNodes.set(currentPath, dir);
        currentChildren.push(dir);
      }
      currentChildren = dir.children;
    }
    currentChildren.push({ kind: "file", path: entry.path, name: fileName });
  }

  sortNodes(root);
  return root;
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
