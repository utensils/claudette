import { memo, useCallback, useEffect, useRef, useState } from "react";
import { isAgentBusy } from "../../utils/agentStatus";
import { ChevronRight, Undo2, Trash2 } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { useTaskTracker } from "../../hooks/useTaskTracker";
import { discardFile, loadDiffFiles, sendRemoteCommand } from "../../services/tauri";
import type { DiffFilesResult } from "../../services/tauri";
import type { DiffFile, DiffLayer } from "../../types/diff";
import {
  AttachmentContextMenu,
  type AttachmentContextMenuItem,
} from "../chat/AttachmentContextMenu";
import { TaskList } from "./TaskList";
import { ScmPanel } from "./ScmPanel";
import { PrStatusBanner } from "./PrStatusBanner";
import {
  DiscardChangesConfirm,
  type DiscardableLayer,
} from "./DiscardChangesConfirm";
import styles from "./RightSidebar.module.css";

function isDiscardableLayer(layer: DiffLayer | undefined): layer is DiscardableLayer {
  return layer === "unstaged" || layer === "untracked";
}

export const RightSidebar = memo(function RightSidebar() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const diffFiles = useAppStore((s) => s.diffFiles);
  const diffStagedFiles = useAppStore((s) => s.diffStagedFiles);
  const diffSelectedFile = useAppStore((s) => s.diffSelectedFile);
  const diffSelectedLayer = useAppStore((s) => s.diffSelectedLayer);
  const diffLoading = useAppStore((s) => s.diffLoading);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const setDiffSelectedFile = useAppStore((s) => s.setDiffSelectedFile);
  const setDiffLoading = useAppStore((s) => s.setDiffLoading);
  const setDiffViewMode = useAppStore((s) => s.setDiffViewMode);
  const diffViewMode = useAppStore((s) => s.diffViewMode);
  const activeTab = useAppStore((s) => s.rightSidebarTab);
  const setActiveTab = useAppStore((s) => s.setRightSidebarTab);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isRunning = isAgentBusy(ws?.agent_status);
  const remoteConnectionId = ws?.remote_connection_id ?? null;
  const worktreePath = ws?.worktree_path ?? null;
  const prevIsRunning = useRef<boolean | undefined>(undefined);

  const { totalCount: taskCount } = useTaskTracker(selectedWorkspaceId);

  // Discard-changes UI state. Local-only — discard isn't bridged through the
  // remote server (matches revert_file), so the action is hidden when the
  // workspace is connected to a remote.
  const [discardTarget, setDiscardTarget] = useState<
    { file: DiffFile; layer: DiscardableLayer } | null
  >(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; file: DiffFile; layer: DiscardableLayer } | null
  >(null);
  const discardEnabled = !remoteConnectionId && worktreePath != null;

  // Load diff files for either local or remote workspace
  const loadDiff = useCallback(
    async (workspaceId: string) => {
      // Guard: workspace may not be in the list yet during creation/deletion
      const currentWs = useAppStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!currentWs) return;

      if (remoteConnectionId) {
        const result = (await sendRemoteCommand(
          remoteConnectionId,
          "load_diff_files",
          { workspace_id: workspaceId }
        )) as DiffFilesResult;

        // Validate response shape to prevent runtime errors
        if (
          !result ||
          typeof result !== "object" ||
          !Array.isArray(result.files) ||
          typeof result.merge_base !== "string"
        ) {
          console.error("Invalid diff files response from remote:", result);
          return;
        }

        return result;
      } else {
        return await loadDiffFiles(workspaceId);
      }
    },
    [remoteConnectionId]
  );

  const applyDiffResult = useCallback(
    (result: DiffFilesResult | undefined) => {
      if (result) {
        setDiffFiles(result.files, result.merge_base, result.staged_files);
      }
    },
    [setDiffFiles]
  );

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    setDiffLoading(true);
    loadDiff(selectedWorkspaceId)
      .then((result) => {
        applyDiffResult(result);
        setDiffLoading(false);
      })
      .catch(() => setDiffLoading(false));
  }, [selectedWorkspaceId, loadDiff, applyDiffResult, setDiffLoading]);

  // Live-refresh diff files while agent is running (every 3s).
  useEffect(() => {
    if (!selectedWorkspaceId || !isRunning) return;

    const interval = setInterval(() => {
      loadDiff(selectedWorkspaceId)
        .then((result) => applyDiffResult(result))
        .catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [isRunning, selectedWorkspaceId, loadDiff, applyDiffResult]);

  // Final refresh when agent stops running (after making changes).
  useEffect(() => {
    const wasRunning = prevIsRunning.current;
    prevIsRunning.current = isRunning;

    if (!selectedWorkspaceId || wasRunning !== true || isRunning) return;

    const timer = setTimeout(() => {
      setDiffLoading(true);
      loadDiff(selectedWorkspaceId)
        .then((result) => {
          applyDiffResult(result);
          setDiffLoading(false);
        })
        .catch((e) => {
          console.error("Failed to refresh diff files:", e);
          setDiffLoading(false);
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [isRunning, selectedWorkspaceId, loadDiff, applyDiffResult, setDiffLoading]);

  const statusLabel = (status: string | { Renamed: { from: string } }) => {
    if (typeof status === "string") {
      return status === "Added"
        ? "A"
        : status === "Modified"
          ? "M"
          : "D";
    }
    return "R";
  };

  const statusColor = (status: string | { Renamed: { from: string } }) => {
    if (typeof status === "string") {
      return status === "Added"
        ? "var(--diff-added-text)"
        : status === "Modified"
          ? "var(--tool-task)"
          : "var(--diff-removed-text)";
    }
    return "var(--diff-hunk-header)";
  };

  const renderFileRow = (file: DiffFile, layer?: DiffLayer) => {
    const isSelected = diffSelectedFile === file.path
      && (diffSelectedLayer ?? "flat") === (layer ?? "flat");
    const canDiscard = discardEnabled && isDiscardableLayer(layer);

    const handleContextMenu = (e: React.MouseEvent) => {
      if (!canDiscard) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, file, layer });
    };

    const handleDiscardClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canDiscard) return;
      setDiscardTarget({ file, layer });
    };

    return (
    <div
      key={`${layer ?? "flat"}-${file.path}`}
      className={`${styles.file} ${isSelected ? styles.fileSelected : ""}`}
      onClick={() => setDiffSelectedFile(file.path, layer)}
      onContextMenu={handleContextMenu}
    >
      <span
        className={styles.status}
        style={{ color: statusColor(file.status) }}
      >
        {statusLabel(file.status)}
      </span>
      <span className={styles.path}>{file.path}</span>
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className={styles.stats}>
          {file.additions !== undefined && (
            <span className={styles.additions}>+{file.additions}</span>
          )}
          {file.deletions !== undefined && (
            <span className={styles.deletions}>-{file.deletions}</span>
          )}
        </span>
      )}
      {canDiscard && (
        <button
          type="button"
          className={styles.rowAction}
          onClick={handleDiscardClick}
          title={
            layer === "untracked"
              ? `Delete ${file.path}`
              : `Discard changes to ${file.path}`
          }
          aria-label={
            layer === "untracked"
              ? `Delete ${file.path}`
              : `Discard changes to ${file.path}`
          }
        >
          {layer === "untracked" ? (
            <Trash2 size={12} />
          ) : (
            <Undo2 size={12} />
          )}
        </button>
      )}
    </div>
    );
  };

  const performDiscard = useCallback(
    async (filePath: string, layer: DiscardableLayer) => {
      if (!worktreePath || !selectedWorkspaceId) return;
      await discardFile(worktreePath, filePath, layer === "untracked");

      // Clear selection if the discarded file was selected so the diff
      // viewer doesn't keep displaying a stale entry.
      const state = useAppStore.getState();
      if (state.diffSelectedFile === filePath) {
        state.setDiffSelectedFile(null);
      }

      const result = await loadDiff(selectedWorkspaceId);
      applyDiffResult(result);
    },
    [worktreePath, selectedWorkspaceId, loadDiff, applyDiffResult]
  );

  // Determine if we have grouped data to show
  const hasGrouped = diffStagedFiles &&
    (diffStagedFiles.committed.length > 0 ||
     diffStagedFiles.staged.length > 0 ||
     diffStagedFiles.unstaged.length > 0 ||
     diffStagedFiles.untracked.length > 0);

  return (
    <div className={styles.panel}>
      <PrStatusBanner />
      <div className={styles.tabBar} data-tauri-drag-region>
        <button
          className={`${styles.tab} ${activeTab === "changes" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("changes")}
        >
          Changes
          {diffFiles.length > 0 && (
            <span className={styles.tabBadge}>{diffFiles.length}</span>
          )}
        </button>
        <button
          className={`${styles.tab} ${activeTab === "tasks" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("tasks")}
        >
          Tasks
          {taskCount > 0 && (
            <span className={styles.tabBadge}>{taskCount}</span>
          )}
        </button>
        <button
          className={`${styles.tab} ${activeTab === "scm" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("scm")}
        >
          SCM
        </button>
      </div>

      {activeTab === "changes" && (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              Changed Files ({diffFiles.length})
            </span>
            <div className={styles.controls}>
              <button
                className={styles.modeBtn}
                onClick={() =>
                  setDiffViewMode(
                    diffViewMode === "Unified" ? "SideBySide" : "Unified"
                  )
                }
                title="Toggle view mode"
              >
                {diffViewMode === "Unified" ? "≡" : "‖"}
              </button>
            </div>
          </div>
          <div className={styles.list}>
            {diffLoading ? (
              <div className={styles.empty}>Loading...</div>
            ) : diffFiles.length === 0 ? (
              <div className={styles.empty}>No changes</div>
            ) : hasGrouped ? (
              <>
                <FileGroup
                  label="Committed"
                  files={diffStagedFiles!.committed}
                  layer="committed"
                  accentColor="var(--diff-added-text)"
                  renderFileRow={renderFileRow}
                />
                <FileGroup
                  label="Staged"
                  files={diffStagedFiles!.staged}
                  layer="staged"
                  accentColor="var(--accent-dim)"
                  renderFileRow={renderFileRow}
                />
                <FileGroup
                  label="Unstaged"
                  files={diffStagedFiles!.unstaged}
                  layer="unstaged"
                  accentColor="var(--tool-task)"
                  renderFileRow={renderFileRow}
                />
                <FileGroup
                  label="Untracked"
                  files={diffStagedFiles!.untracked}
                  layer="untracked"
                  accentColor="var(--text-dim)"
                  renderFileRow={renderFileRow}
                />
              </>
            ) : (
              // Fallback: flat list (remote server without staged_files)
              diffFiles.map((file) => renderFileRow(file))
            )}
          </div>
        </>
      )}

      {activeTab === "tasks" && (
        selectedWorkspaceId
          ? <TaskList workspaceId={selectedWorkspaceId} />
          : <div className={styles.list}><div className={styles.empty}>No workspace selected</div></div>
      )}

      {activeTab === "scm" && <ScmPanel />}

      {contextMenu && (
        <AttachmentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildDiscardMenuItems(contextMenu.layer, () => {
            setDiscardTarget({ file: contextMenu.file, layer: contextMenu.layer });
          })}
          onClose={() => setContextMenu(null)}
        />
      )}

      {discardTarget && (
        <DiscardChangesConfirm
          filePath={discardTarget.file.path}
          layer={discardTarget.layer}
          onConfirm={() => performDiscard(discardTarget.file.path, discardTarget.layer)}
          onClose={() => setDiscardTarget(null)}
        />
      )}
    </div>
  );
});

function buildDiscardMenuItems(
  layer: DiscardableLayer,
  onDiscard: () => void,
): AttachmentContextMenuItem[] {
  const isUntracked = layer === "untracked";
  return [
    {
      label: isUntracked ? "Delete file…" : "Discard changes…",
      icon: isUntracked ? <Trash2 size={14} /> : <Undo2 size={14} />,
      onSelect: onDiscard,
    },
  ];
}

function FileGroup({
  label,
  files,
  layer,
  accentColor,
  renderFileRow,
}: {
  label: string;
  files: DiffFile[];
  layer: DiffLayer;
  accentColor: string;
  renderFileRow: (file: DiffFile, layer?: DiffLayer) => React.ReactElement;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (files.length === 0) return null;

  return (
    <div className={styles.fileGroup} style={{ borderLeftColor: accentColor }}>
      <button
        className={styles.groupHeader}
        onClick={() => setCollapsed(!collapsed)}
      >
        <ChevronRight
          size={12}
          className={`${styles.groupChevron} ${!collapsed ? styles.groupChevronOpen : ""}`}
        />
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupCount}>{files.length}</span>
      </button>
      {!collapsed && files.map((file) => renderFileRow(file, layer))}
    </div>
  );
}
