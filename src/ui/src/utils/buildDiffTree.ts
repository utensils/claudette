import type { DiffFile } from "../types/diff";

export type DiffTreeNode =
  | {
      kind: "dir";
      /** Display label — may be a compressed multi-segment path e.g. "ui/src" */
      label: string;
      /** Full path to the deepest dir in the compressed chain (no trailing slash) */
      path: string;
      children: DiffTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      file: DiffFile;
    };

interface RawDirNode {
  kind: "dir";
  name: string;
  path: string;
  children: (RawDirNode | RawFileNode)[];
}

interface RawFileNode {
  kind: "file";
  name: string;
  path: string;
  file: DiffFile;
}

type RawNode = RawDirNode | RawFileNode;

/** Build a compressed directory tree from a flat list of diff files.
 *  Directories with a single child directory and no files are collapsed
 *  into a single node with a joined label (e.g. "ui/src"), matching VS
 *  Code's "compact folders" behaviour. */
export function buildDiffTree(files: DiffFile[]): DiffTreeNode[] {
  const root: RawNode[] = [];
  const dirs = new Map<string, RawDirNode>();

  for (const file of files) {
    const parts = file.path.split("/");
    const fileName = parts[parts.length - 1];

    let currentChildren: RawNode[] = root;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      currentPath += (currentPath ? "/" : "") + seg;
      let dir = dirs.get(currentPath);
      if (!dir) {
        dir = { kind: "dir", name: seg, path: currentPath, children: [] };
        dirs.set(currentPath, dir);
        currentChildren.push(dir);
      }
      currentChildren = dir.children;
    }

    currentChildren.push({ kind: "file", name: fileName, path: file.path, file });
  }

  sortNodes(root);
  return root.map(compressNode);
}

function sortNodes(nodes: RawNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) {
    if (n.kind === "dir") sortNodes(n.children);
  }
}

function compressNode(node: RawNode): DiffTreeNode {
  if (node.kind === "file") return node;

  let label = node.name;
  let children: DiffTreeNode[] = node.children.map(compressNode);

  // Collapse single-child-dir chains into one node with a joined label.
  while (children.length === 1 && children[0].kind === "dir") {
    const only = children[0];
    label = label + "/" + only.label;
    children = only.children;
  }

  return { kind: "dir", label, path: node.path, children };
}
