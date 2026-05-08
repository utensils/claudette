import {
  memo,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
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
import type { DiffLayer } from "../../types/diff";
import type { FileContextTarget } from "./fileContextMenu";
import { InlineRenameInput } from "./InlineRenameInput";
import {
  resolveFileTreeActivation,
  statusColor,
  statusLabel,
} from "./fileTreeStatus";
import styles from "./FileTree.module.css";

interface FileTreeProps {
  /** Workspace this tree belongs to. Drives per-workspace expansion +
   *  selection state so switching workspaces doesn't smear tree UI state
   *  from one repo onto another. */
  workspaceId: string;
  entries: FileEntry[];
  /** Called when the user activates a file row (click / Enter / Space).
   *  The parent decides whether to actually open it (e.g. it may show a
   *  discard-changes modal first if there are unsaved changes). */
  onActivateFile: (path: string) => void;
  onActivateDiff: (path: string, layer: DiffLayer | null) => void;
  onContextMenu: (target: FileContextTarget, x: number, y: number) => void;
  creatingParentPath: string | null;
  onCreateCommit: (parentPath: string, name: string) => Promise<boolean>;
  onCreateCancel: () => void;
  focusRequest: number;
  renamingPath: string | null;
  onRenameCommit: (
    target: FileContextTarget,
    newName: string,
  ) => Promise<boolean>;
  onRenameCancel: () => void;
}

const EMPTY_EXPANDED: Record<string, boolean> = {};

export const FileTree = memo(function FileTree({
  workspaceId,
  entries,
  onActivateFile,
  onActivateDiff,
  onContextMenu,
  creatingParentPath,
  onCreateCommit,
  onCreateCancel,
  focusRequest,
  renamingPath,
  onRenameCommit,
  onRenameCancel,
}: FileTreeProps) {
  const expanded = useAppStore(
    (s) => s.allFilesExpandedDirsByWorkspace[workspaceId] ?? EMPTY_EXPANDED,
  );
  const selected = useAppStore(
    (s) => s.allFilesSelectedPathByWorkspace[workspaceId] ?? null,
  );
  const toggleDirAction = useAppStore((s) => s.toggleAllFilesDir);
  const setExpandedAction = useAppStore((s) => s.setAllFilesDirExpanded);
  const setSelectedAction = useAppStore((s) => s.setAllFilesSelectedPath);
  // Pre-bind the workspace into the action callables so the existing
  // call sites read like the previous (workspace-implicit) API. Stable
  // identities across renders keep the keyboard-handler useCallback
  // memoization meaningful.
  const toggleDir = useCallback(
    (path: string) => toggleDirAction(workspaceId, path),
    [toggleDirAction, workspaceId],
  );
  const setExpanded = useCallback(
    (path: string, exp: boolean) => setExpandedAction(workspaceId, path, exp),
    [setExpandedAction, workspaceId],
  );
  const setSelected = useCallback(
    (path: string | null) => setSelectedAction(workspaceId, path),
    [setSelectedAction, workspaceId],
  );

  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const visible = useMemo(
    () => flattenVisible(tree, expanded),
    [tree, expanded],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  // Map of treeitem element refs keyed by node path. Used to programmatically
  // move focus on keyboard navigation — the WAI-ARIA tree pattern requires
  // focus to follow the selection so the screen reader announces the row.
  const rowRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  /** The row that should currently be in the tab order (roving tabindex).
   *  Falls back to the first visible row when no row is selected, so the
   *  tree is reachable via keyboard from a fresh state. */
  const focusedIndex = useMemo(() => {
    if (visible.length === 0) return -1;
    const idx = selected
      ? visible.findIndex((v) => v.node.path === selected)
      : -1;
    return idx >= 0 ? idx : 0;
  }, [visible, selected]);
  const focusedPath =
    focusedIndex >= 0 ? visible[focusedIndex].node.path : null;
  const previousRenamingPathRef = useRef<string | null>(null);

  // Keep the focused row in view, and re-focus it programmatically when the
  // selection changes — but only when focus is already inside the tree. The
  // guard prevents the tree from yanking focus away when the user's typing
  // in chat or the diff viewer and the selection changes for an unrelated
  // reason (e.g. an external action).
  useEffect(() => {
    if (!focusedPath) return;
    const el = rowRefsRef.current.get(focusedPath);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    if (containerRef.current?.contains(document.activeElement)) {
      el.focus();
    }
  }, [focusedPath]);

  useEffect(() => {
    const previous = previousRenamingPathRef.current;
    previousRenamingPathRef.current = renamingPath;
    if (previous === null || renamingPath !== null) return;
    const selectedPath = selected ?? focusedPath;
    if (!selectedPath) return;
    requestAnimationFrame(() => {
      rowRefsRef.current.get(selectedPath)?.focus();
    });
  }, [focusedPath, renamingPath, selected]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const focusPath = selected ?? focusedPath;
    requestAnimationFrame(() => {
      if (focusPath) {
        rowRefsRef.current.get(focusPath)?.focus();
      } else {
        rowRefsRef.current.values().next().value?.focus();
      }
    });
  }, [focusedPath, focusRequest, selected]);

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
            const activation = resolveFileTreeActivation(cur.node);
            if (activation.kind === "diff") {
              onActivateDiff(activation.path, activation.layer);
            } else {
              onActivateFile(activation.path);
            }
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
      onActivateDiff,
    ],
  );

  // ref-callback factory: register/unregister each row in the focus map by
  // path so the focusedPath effect can `.focus()` whichever row becomes
  // focused, regardless of where it lives in the visible list.
  const registerRowRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) rowRefsRef.current.set(path, el);
      else rowRefsRef.current.delete(path);
    },
    [],
  );

  if (entries.length === 0 && creatingParentPath === null) {
    return <div className={styles.empty}>No files</div>;
  }

  const createParentClean =
    creatingParentPath === null ? null : stripTrailingSlash(creatingParentPath);
  const createRowIndex =
    createParentClean === null || createParentClean === ""
      ? 0
      : visible.findIndex(
          ({ node }) =>
            node.kind === "dir" && stripTrailingSlash(node.path) === createParentClean,
        ) + 1;

  return (
    <div
      className={styles.tree}
      ref={containerRef}
      role="tree"
      aria-label="Project files"
      onKeyDown={handleKeyDown}
    >
      {creatingParentPath !== null && createRowIndex === 0 && (
        <CreateRow
          depth={0}
          parentPath={creatingParentPath}
          onCreateCommit={onCreateCommit}
          onCreateCancel={onCreateCancel}
        />
      )}
      {visible.map(({ node, depth }, idx) => {
        const showCreateAfter =
          creatingParentPath !== null && createRowIndex === idx + 1;
        return (
          <Fragment key={node.path}>
            <Row
              node={node}
              depth={depth}
              expanded={node.kind === "dir" ? !!expanded[node.path] : false}
              selected={selected === node.path}
              renaming={renamingPath === node.path}
              // Roving tabindex: exactly one row in the tree is in the tab
              // order at any time. Tab moves focus into the tree (or out of
              // it); arrow keys move within.
              tabbable={idx === focusedIndex}
              rowRef={registerRowRef(node.path)}
              onClick={() => {
                setSelected(node.path);
                if (node.kind === "dir") {
                  toggleDir(node.path);
                } else {
                  const activation = resolveFileTreeActivation(node);
                  if (activation.kind === "diff") {
                    onActivateDiff(activation.path, activation.layer);
                  } else {
                    onActivateFile(activation.path);
                  }
                }
              }}
              onContextMenu={(x, y) => {
                setSelected(node.path);
                onContextMenu(
                  {
                    path: node.path,
                    isDirectory: node.kind === "dir",
                    exists:
                      node.kind === "dir" ||
                      node.git_status == null ||
                      node.git_status !== "Deleted",
                  },
                  x,
                  y,
                );
              }}
              onRenameCommit={(name) =>
                onRenameCommit(
                  {
                    path: node.path,
                    isDirectory: node.kind === "dir",
                    exists:
                      node.kind === "dir" ||
                      node.git_status == null ||
                      node.git_status !== "Deleted",
                  },
                  name,
                )
              }
              onRenameCancel={onRenameCancel}
            />
            {showCreateAfter && (
              <CreateRow
                depth={depth + 1}
                parentPath={creatingParentPath}
                onCreateCommit={onCreateCommit}
                onCreateCancel={onCreateCancel}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
});

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/g, "");
}

interface CreateRowProps {
  depth: number;
  parentPath: string;
  onCreateCommit: (parentPath: string, name: string) => Promise<boolean>;
  onCreateCancel: () => void;
}

function CreateRow({
  depth,
  parentPath,
  onCreateCommit,
  onCreateCancel,
}: CreateRowProps) {
  const Icon = getFileIcon("untitled");
  return (
    <div
      className={styles.row}
      style={{ ["--depth" as string]: depth }}
      role="treeitem"
      aria-level={depth + 1}
    >
      <span className={styles.chevron} style={{ width: 12, height: 12 }} />
      {/* eslint-disable-next-line react-hooks/static-components -- fileIcons returns stable module-level lucide components. */}
      <Icon size={14} className={styles.icon} aria-hidden="true" />
      <InlineRenameInput
        name="untitled"
        className={styles.renameInput}
        ariaLabel="New file name"
        onCommit={(name) => onCreateCommit(parentPath, name)}
        onCancel={onCreateCancel}
      />
    </div>
  );
}

interface RowProps {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  renaming: boolean;
  tabbable: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onClick: () => void;
  onContextMenu: (x: number, y: number) => void;
  onRenameCommit: (name: string) => Promise<boolean>;
  onRenameCancel: () => void;
}

function Row({
  node,
  depth,
  expanded,
  selected,
  renaming,
  tabbable,
  rowRef,
  onClick,
  onContextMenu,
  onRenameCommit,
  onRenameCancel,
}: RowProps) {
  const isDir = node.kind === "dir";
  const ChevronIcon = isDir
    ? expanded
      ? ChevronDown
      : ChevronRight
    : null;
  const Icon = isDir ? getFolderIcon(expanded) : getFileIcon(node.name);
  const status = node.kind === "file" ? node.git_status : null;
  const statusLayer = node.kind === "file" ? node.git_layer : null;
  const folderStatus = node.kind === "dir" ? node.folderStatus : null;
  const tintStatus = status ?? folderStatus;
  const statusTitle =
    status == null
      ? null
      : typeof status === "string"
        ? status
        : `Renamed from ${status.Renamed.from}`;
  const rowClassName = [
    styles.row,
    selected ? styles.rowSelected : "",
    status === "Deleted" ? styles.rowDeleted : "",
    tintStatus ? styles.rowStatusTinted : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Publish the row's tint as a custom property so the icon, name, and
  // dirStatus badge rules in FileTree.module.css can all reference one
  // source of truth without each receiving its own inline `style`.
  const rowStyle = {
    ["--depth" as string]: depth,
    ...(tintStatus
      ? { ["--row-status-color" as string]: statusColor(tintStatus) }
      : {}),
  };

  return (
    <div
      ref={rowRef}
      className={rowClassName}
      style={rowStyle}
      role="treeitem"
      tabIndex={tabbable ? 0 : -1}
      aria-selected={selected}
      // WAI-ARIA tree levels are 1-indexed; root rows are level 1.
      aria-level={depth + 1}
      // Per the spec, `aria-expanded` is meaningful only on rows that have
      // children (or could). Omit it on file rows entirely so screen
      // readers don't announce a misleading collapsed/expanded state.
      aria-expanded={isDir ? expanded : undefined}
      onClick={
        renaming
          ? undefined
          : (event) => {
              event.currentTarget.focus();
              onClick();
            }
      }
      onContextMenu={(event) => {
        event.preventDefault();
        if (renaming) return;
        event.currentTarget.focus();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      {ChevronIcon ? (
        <ChevronIcon size={12} className={styles.chevron} aria-hidden="true" />
      ) : (
        // 12-px spacer keeps file rows aligned with their sibling folders.
        <span className={styles.chevron} style={{ width: 12, height: 12 }} />
      )}
      {/* eslint-disable-next-line react-hooks/static-components -- fileIcons returns stable module-level lucide components. */}
      <Icon size={14} className={styles.icon} aria-hidden="true" />
      {renaming ? (
        <InlineRenameInput
          name={node.name}
          className={styles.renameInput}
          ariaLabel={`Rename ${node.name}`}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className={styles.name}>{node.name}</span>
      )}
      {node.kind === "dir" && node.statusCount > 0 && (
        <span
          className={styles.dirStatus}
          title={`${node.statusCount} changed ${node.statusCount === 1 ? "file" : "files"}`}
          aria-label={`${node.statusCount} changed ${node.statusCount === 1 ? "file" : "files"}`}
        >
          {node.statusCount}
        </span>
      )}
      {status && (
        <span
          className={styles.status}
          title={statusTitle ?? undefined}
          aria-label={statusTitle ?? undefined}
        >
          {statusLabel(status, statusLayer)}
        </span>
      )}
    </div>
  );
}
