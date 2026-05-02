import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  /** Workspace this tree belongs to. Drives per-workspace expansion +
   *  selection state so switching workspaces doesn't smear tree UI state
   *  from one repo onto another. */
  workspaceId: string;
  entries: FileEntry[];
  /** Called when the user activates a file row (click / Enter / Space).
   *  The parent decides whether to actually open it (e.g. it may show a
   *  discard-changes modal first if there are unsaved changes). */
  onActivateFile: (path: string) => void;
}

const EMPTY_EXPANDED: Record<string, boolean> = {};

/** Row height in pixels. Must match `.row` height in FileTree.module.css —
 *  the virtualizer sizes the scroll container off this estimate. */
const ROW_HEIGHT = 22;

/** Number of off-screen rows to keep mounted on each side of the viewport.
 *  Larger values give smoother scroll at the cost of more DOM nodes. */
const OVERSCAN = 12;

export const FileTree = memo(function FileTree({
  workspaceId,
  entries,
  onActivateFile,
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

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

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

  // Keep the focused row in view, and re-focus it programmatically when the
  // selection changes — but only when focus is already inside the tree. The
  // guard prevents the tree from yanking focus away when the user's typing
  // in chat or the diff viewer and the selection changes for an unrelated
  // reason (e.g. an external action).
  //
  // Virtualization caveat: the focused row may not be rendered yet. Ask the
  // virtualizer to scroll it into view first, then on the next layout pass
  // query the DOM by data-path and focus the (now-rendered) row.
  useLayoutEffect(() => {
    if (focusedIndex < 0 || !focusedPath) return;
    virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    if (containerRef.current?.contains(document.activeElement)) {
      // Wait one frame so the virtualizer has rendered the target row.
      const raf = requestAnimationFrame(() => {
        const el = containerRef.current?.querySelector<HTMLDivElement>(
          `[data-path="${cssEscape(focusedPath)}"]`,
        );
        el?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [focusedIndex, focusedPath, virtualizer]);

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

  const totalSize = virtualizer.getTotalSize();
  const items = virtualizer.getVirtualItems();

  return (
    <div
      className={styles.tree}
      ref={containerRef}
      role="tree"
      aria-label="Project files"
      onKeyDown={handleKeyDown}
    >
      {/* Sized inner container; height equals the full virtual list so the
       * scrollbar reflects the real range, even though only the visible
       * window is in the DOM. */}
      <div
        className={styles.virtualInner}
        style={{ height: `${totalSize}px` }}
      >
        {items.map((vi) => {
          const { node, depth } = visible[vi.index];
          return (
            <Row
              key={vi.key}
              node={node}
              depth={depth}
              expanded={node.kind === "dir" ? !!expanded[node.path] : false}
              selected={selected === node.path}
              // Roving tabindex: exactly one row in the tree is in the tab
              // order at any time. Tab moves focus into the tree (or out of
              // it); arrow keys move within.
              tabbable={vi.index === focusedIndex}
              // ARIA: communicate the full virtual list size to assistive
              // tech, since the rendered row count is bounded by overscan.
              ariaPosInSet={vi.index + 1}
              ariaSetSize={visible.length}
              translateY={vi.start}
              onClick={() => {
                setSelected(node.path);
                if (node.kind === "dir") {
                  toggleDir(node.path);
                } else {
                  onActivateFile(node.path);
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
});

interface RowProps {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  tabbable: boolean;
  ariaPosInSet: number;
  ariaSetSize: number;
  translateY: number;
  onClick: () => void;
}

function Row({
  node,
  depth,
  expanded,
  selected,
  tabbable,
  ariaPosInSet,
  ariaSetSize,
  translateY,
  onClick,
}: RowProps) {
  const isDir = node.kind === "dir";
  const ChevronIcon = isDir
    ? expanded
      ? ChevronDown
      : ChevronRight
    : null;
  const Icon = isDir ? getFolderIcon(expanded) : getFileIcon(node.name);

  return (
    <div
      // Position by transform — the inner container has explicit height,
      // each row is absolutely-positioned with a translateY offset. This
      // is the recommended pattern from @tanstack/react-virtual for
      // hardware-accelerated scrolling.
      className={`${styles.row} ${selected ? styles.rowSelected : ""}`}
      style={{
        ["--depth" as string]: depth,
        transform: `translateY(${translateY}px)`,
      }}
      data-path={node.path}
      role="treeitem"
      tabIndex={tabbable ? 0 : -1}
      aria-selected={selected}
      // WAI-ARIA tree levels are 1-indexed; root rows are level 1.
      aria-level={depth + 1}
      // Per the spec, `aria-expanded` is meaningful only on rows that have
      // children (or could). Omit it on file rows entirely so screen
      // readers don't announce a misleading collapsed/expanded state.
      aria-expanded={isDir ? expanded : undefined}
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
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

/** Escape a string for use in a CSS attribute selector. Browsers expose
 *  `CSS.escape`, but file paths can contain any character so we need a
 *  defensive wrapper that survives unusual filenames in tests too. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["\\\n])/g, "\\$1");
}
