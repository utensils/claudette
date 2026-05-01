import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  buildFileTree,
  flattenVisible,
  type FileTreeNode,
} from "../../utils/buildFileTree";
import { getFileIcon, getFolderIcon } from "../../utils/fileIcons";
import type { FileEntry } from "../../services/tauri";
import styles from "./FileTree.module.css";

interface FileTreeProps {
  entries: FileEntry[];
  /** Called when the user activates a file row (click / Enter / Space).
   *  The parent decides whether to actually open it (e.g. it may show a
   *  discard-changes modal first if there are unsaved changes). */
  onActivateFile: (path: string) => void;
}

export const FileTree = memo(function FileTree({
  entries,
  onActivateFile,
}: FileTreeProps) {
  const expanded = useAppStore((s) => s.allFilesExpandedDirs);
  const selected = useAppStore((s) => s.allFilesSelectedPath);
  const toggleDir = useAppStore((s) => s.toggleAllFilesDir);
  const setExpanded = useAppStore((s) => s.setAllFilesDirExpanded);
  const setSelected = useAppStore((s) => s.setAllFilesSelectedPath);

  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const visible = useMemo(
    () => flattenVisible(tree, expanded),
    [tree, expanded],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRowRef = useRef<HTMLDivElement>(null);

  // Keep the selected row in view when it changes (e.g. via keyboard).
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const findVisibleIndex = useCallback(
    (path: string | null) =>
      path === null ? -1 : visible.findIndex((v) => v.node.path === path),
    [visible],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visible.length === 0) return;
      const currentIndex = findVisibleIndex(selected);

      const moveTo = (idx: number) => {
        if (idx < 0 || idx >= visible.length) return;
        setSelected(visible[idx].node.path);
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, visible.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          moveTo(currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0));
          break;
        case "ArrowRight": {
          e.preventDefault();
          const cur = currentIndex >= 0 ? visible[currentIndex] : null;
          if (cur && cur.node.kind === "dir") {
            if (!expanded[cur.node.path]) {
              setExpanded(cur.node.path, true);
            } else if (currentIndex + 1 < visible.length) {
              moveTo(currentIndex + 1);
            }
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          const cur = currentIndex >= 0 ? visible[currentIndex] : null;
          if (cur && cur.node.kind === "dir" && expanded[cur.node.path]) {
            setExpanded(cur.node.path, false);
          } else if (cur) {
            // Move selection up to the parent dir (the row whose depth is
            // exactly one less than ours and that comes before us). Walk
            // backwards; the first such row is the parent.
            const myDepth = visible[currentIndex].depth;
            for (let i = currentIndex - 1; i >= 0; i--) {
              if (visible[i].depth < myDepth) {
                moveTo(i);
                break;
              }
            }
          }
          break;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          const cur = currentIndex >= 0 ? visible[currentIndex] : null;
          if (!cur) return;
          if (cur.node.kind === "dir") {
            toggleDir(cur.node.path);
          } else {
            onActivateFile(cur.node.path);
          }
          break;
        }
      }
    },
    [
      visible,
      selected,
      expanded,
      findVisibleIndex,
      setSelected,
      setExpanded,
      toggleDir,
      onActivateFile,
    ],
  );

  if (entries.length === 0) {
    return <div className={styles.empty}>No files</div>;
  }

  return (
    <div
      className={styles.tree}
      ref={containerRef}
      tabIndex={0}
      role="tree"
      aria-label="Project files"
      onKeyDown={handleKeyDown}
    >
      {visible.map(({ node, depth }) => (
        <Row
          key={node.path}
          node={node}
          depth={depth}
          expanded={node.kind === "dir" ? !!expanded[node.path] : false}
          selected={selected === node.path}
          rowRef={selected === node.path ? selectedRowRef : undefined}
          onClick={() => {
            setSelected(node.path);
            if (node.kind === "dir") {
              toggleDir(node.path);
            } else {
              onActivateFile(node.path);
            }
          }}
        />
      ))}
    </div>
  );
});

interface RowProps {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  rowRef?: RefObject<HTMLDivElement | null>;
  onClick: () => void;
}

function Row({ node, depth, expanded, selected, rowRef, onClick }: RowProps) {
  const isDir = node.kind === "dir";
  const ChevronIcon = isDir
    ? expanded
      ? ChevronDown
      : ChevronRight
    : null;
  const Icon = isDir ? getFolderIcon(expanded) : getFileIcon(node.name);

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
      style={{ ["--depth" as string]: depth }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={isDir ? expanded : undefined}
      onClick={onClick}
    >
      {ChevronIcon ? (
        <ChevronIcon size={12} className={styles.chevron} aria-hidden="true" />
      ) : (
        // 12-px spacer keeps file rows aligned with their sibling folders.
        <span className={styles.chevron} style={{ width: 12, height: 12 }} />
      )}
      <Icon size={14} className={styles.icon} aria-hidden="true" />
      <span className={styles.name}>{node.name}</span>
    </div>
  );
}
