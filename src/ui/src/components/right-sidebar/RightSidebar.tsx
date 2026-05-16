import { Fragment, memo, useCallback, useEffect, useRef, useState } from "react";
import { isAgentBusy } from "../../utils/agentStatus";
import {
  DIFF_AGENT_RUNNING_INTERVAL_MS,
  IDLE_REFRESH_INTERVAL_MS,
} from "../../utils/pollingIntervals";
import { ChevronRight, Undo2, Trash2, Plus, Minus, FilePenLine } from "lucide-react";
import { useAppStore, selectActiveSessionId } from "../../stores/useAppStore";
import { isPendingPlaceholderWorkspace } from "../../utils/workspaceEnvironment";
import { useWorkspaceTaskHistory } from "../../hooks/useWorkspaceTaskHistory";
import {
  discardFile,
  discardFiles,
  loadDiffFiles,
  sendRemoteCommand,
  stageFile,
  stageFiles,
  unstageFile,
  unstageFiles,
} from "../../services/tauri";
import type { DiffFilesResult } from "../../services/tauri";
import type { CommitEntry, DiffFile, DiffLayer } from "../../types/diff";
import {
  AttachmentContextMenu,
  type AttachmentContextMenuItem,
} from "../chat/AttachmentContextMenu";
import { TaskList } from "./TaskList";
import { PrStatusBanner } from "./PrStatusBanner";
import { FilesPanel } from "../files/FilesPanel";
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
  const clearDiff = useAppStore((s) => s.clearDiff);
  const openDiffTab = useAppStore((s) => s.openDiffTab);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const setDiffLoading = useAppStore((s) => s.setDiffLoading);
  const requestFileTreeRefresh = useAppStore((s) => s.requestFileTreeRefresh);
  const commitHistory = useAppStore((s) => s.commitHistory);
  const diffSelectedCommitHash = useAppStore((s) => s.diffSelectedCommitHash);
  const setDiffSelectedCommitHash = useAppStore((s) => s.setDiffSelectedCommitHash);
  const activeTab = useAppStore((s) => s.rightSidebarTab);
  const setActiveTab = useAppStore((s) => s.setRightSidebarTab);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isRunning = isAgentBusy(ws?.agent_status);
  // Optimistic-fork placeholder selected — backend has no row for this
  // id yet, so every diff/changes/tasks fetch would return "Workspace
  // not found". Gate the load/poll effects so the right sidebar stays
  // quietly empty during the fork instead of flashing error states.
  // Effects re-fire against the real workspace id once
  // `commitPendingFork` swaps the selection.
  const isPendingPlaceholder = useAppStore((s) =>
    isPendingPlaceholderWorkspace(s, selectedWorkspaceId),
  );
  const remoteConnectionId = ws?.remote_connection_id ?? null;
  const worktreePath = ws?.worktree_path ?? null;
  const prevIsRunning = useRef<boolean | undefined>(undefined);
  // Monotonic load token bumped each time a workspace-scoped diff fetch is
  // dispatched. A late response from a previous workspace compares against
  // the current value and bails out so it can't overwrite the new
  // workspace's diff list. Without this, the post-rebase change to keep
  // the file list mounted while reloading (so FileGroup collapse state is
  // preserved) means stale data from workspace A would render until B's
  // fetch resolves.
  const diffLoadVersion = useRef(0);
  // Dedup guard for the two polling intervals. The version-token above is a
  // *coalescing* pattern (latest response wins for UI state); it does not
  // prevent overlapping dispatches. On a slow repo (e.g. nixpkgs where
  // `git merge-base origin/master HEAD` takes ~6s after a fast-forward of
  // upstream/master, exceeding the 3s active polling cadence), unguarded
  // ticks pile up faster than they drain — each tick fans out 4 git
  // invocations on the Rust side and the resulting `git` swarm pegs the
  // machine. The interval ticks consult this counter and skip a tick
  // whenever any previous fetch is still in flight; one-shot loads (initial
  // select, post-stop refresh) always run but still bump the counter so a
  // polling tick that fires inside their window doesn't double up.
  //
  // A counter (rather than a boolean) is required because overlapping loads
  // are possible across workspace switches: switching to workspace B while
  // workspace A's load is still pending starts B's load while A is still
  // running, and A's earlier-resolving `.finally` would open the gate while
  // B is still in flight if the guard were a boolean. Decrementing only
  // when each individual dispatch resolves keeps the gate closed until the
  // last in-flight load drains. Decrement lives in `.finally` so an error
  // path can't permanently wedge the gate.
  const loadDiffInFlightCount = useRef(0);

  const activeSessionId = useAppStore(selectActiveSessionId);
  const taskHistory = useWorkspaceTaskHistory(
    selectedWorkspaceId,
    activeSessionId,
    activeTab === "tasks",
  );
  const taskCount = taskHistory.totalBadgeCount;

  // `useWorkspaceTaskHistory` already derives the active session's
  // `current` + `subagents` snapshot (it's the lightweight IO-free
  // half of the hook — only the cross-session history fetch is gated
  // on `historyEnabled`). Reuse that here instead of double-subscribing
  // through `useTaskTrackerWithHistory`, so the auto-switch signal
  // doesn't trigger a redundant derivation on every tool-activity
  // update.
  const hasLiveTasks =
    taskHistory.current.tasks.length > 0 ||
    taskHistory.subagents.length > 0;
  // One auto-switch per workspace selection. Tracks the workspace ids
  // we've already auto-switched for and reset on workspace change so
  // each workspace gets at most one nudge before it learns the user's
  // tab preference for the remainder of the session.
  const autoSwitchedForWorkspaceRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedWorkspaceId || !hasLiveTasks) return;
    if (autoSwitchedForWorkspaceRef.current.has(selectedWorkspaceId)) return;
    if (activeTab === "tasks") {
      autoSwitchedForWorkspaceRef.current.add(selectedWorkspaceId);
      return;
    }
    autoSwitchedForWorkspaceRef.current.add(selectedWorkspaceId);
    setActiveTab("tasks");
  }, [selectedWorkspaceId, hasLiveTasks, activeTab, setActiveTab]);

  // Local-only stage/unstage/discard UI state. None of these git index
  // operations are bridged through the remote server (matches revert_file),
  // so the actions are hidden when the workspace is connected to a remote.
  const [discardTarget, setDiscardTarget] = useState<
    { file: DiffFile; layer: DiscardableLayer } | null
  >(null);
  const [bulkDiscardTarget, setBulkDiscardTarget] = useState<
    { files: DiffFile[]; layer: DiscardableLayer } | null
  >(null);
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; file: DiffFile; layer: DiscardableLayer } | null
  >(null);
  // Gates stage/unstage/discard (single + bulk). Hidden when connected to a
  // remote (the server doesn't bridge index ops) or when there's no local
  // worktree to operate against.
  const localGitOpsEnabled = !remoteConnectionId && worktreePath != null;
  // True while a stage/unstage/discard git invocation is awaiting. Disables
  // every action button so rapid clicks can't fire overlapping `git add` /
  // `git restore` calls that would race on `.git/index.lock`.
  const [gitOpInFlight, setGitOpInFlight] = useState(false);

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
        setDiffFiles(result.files, result.merge_base, result.staged_files, result.commits);
      }
    },
    [setDiffFiles]
  );

  // Two-part staleness guard for in-flight diff fetches:
  //
  //   1. The version-token check catches the case where a *newer* fetch has
  //      since been dispatched (initial load, post-stop refresh, active
  //      poll, idle poll) — the latest one wins.
  //   2. The selectedWorkspaceId getState check catches the case where the
  //      user has switched workspaces but the new workspace's effect has
  //      not yet bumped the version — without this, a late response from
  //      the previous workspace can sneak through and overwrite the new
  //      workspace's diff list.
  //
  // The version ref is bumped synchronously when each fetch is dispatched,
  // but `diffLoadVersion` was originally only consulted by the same effect
  // that dispatched, so prior work to add the second guard only landed on
  // the new idle path. Centralizing the check protects every call site —
  // mirrors how `FilesPanel.loadFiles` guards its own fetches.
  const isDiffResultStillValid = useCallback(
    (workspaceId: string, version: number): boolean =>
      version === diffLoadVersion.current &&
      useAppStore.getState().selectedWorkspaceId === workspaceId,
    [],
  );

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    // Clear before fetching so the file list, badge, and selection from the
    // previous workspace don't leak into the new one while the fetch is in
    // flight. The empty-list fallback `diffFiles.length === 0 && diffLoading`
    // then renders "Loading..." instead of stale rows.
    clearDiff();
    if (isPendingPlaceholder) {
      // Placeholder workspace — the backend doesn't have this id yet.
      // Skip the fetch entirely; the effect re-runs when commit swaps
      // selection to the real workspace.
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    const version = ++diffLoadVersion.current;
    const workspaceId = selectedWorkspaceId;
    loadDiffInFlightCount.current += 1;
    loadDiff(workspaceId)
      .then((result) => {
        if (!isDiffResultStillValid(workspaceId, version)) return;
        applyDiffResult(result);
        setDiffLoading(false);
      })
      .catch(() => {
        if (!isDiffResultStillValid(workspaceId, version)) return;
        setDiffLoading(false);
      })
      .finally(() => {
        loadDiffInFlightCount.current -= 1;
      });
  }, [selectedWorkspaceId, loadDiff, applyDiffResult, setDiffLoading, clearDiff, isDiffResultStillValid, isPendingPlaceholder]);

  // Live-refresh diff files while agent is running.
  useEffect(() => {
    if (!selectedWorkspaceId || isPendingPlaceholder || !isRunning) return;
    const workspaceId = selectedWorkspaceId;

    const interval = setInterval(() => {
      // Skip this tick if the previous fetch hasn't resolved. Without this,
      // on a slow repo each `git merge-base` outlives the 3s polling
      // cadence and the swarm grows linearly until the machine melts.
      if (loadDiffInFlightCount.current > 0) return;
      const version = ++diffLoadVersion.current;
      loadDiffInFlightCount.current += 1;
      loadDiff(workspaceId)
        .then((result) => {
          if (!isDiffResultStillValid(workspaceId, version)) return;
          applyDiffResult(result);
        })
        .catch(() => {})
        .finally(() => {
          loadDiffInFlightCount.current -= 1;
        });
    }, DIFF_AGENT_RUNNING_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isRunning, selectedWorkspaceId, loadDiff, applyDiffResult, isDiffResultStillValid, isPendingPlaceholder]);

  // Final refresh when agent stops running (after making changes).
  useEffect(() => {
    const wasRunning = prevIsRunning.current;
    prevIsRunning.current = isRunning;

    if (!selectedWorkspaceId || isPendingPlaceholder || wasRunning !== true || isRunning) return;
    const workspaceId = selectedWorkspaceId;

    const timer = setTimeout(() => {
      setDiffLoading(true);
      const version = ++diffLoadVersion.current;
      loadDiffInFlightCount.current += 1;
      loadDiff(workspaceId)
        .then((result) => {
          if (!isDiffResultStillValid(workspaceId, version)) return;
          applyDiffResult(result);
          setDiffLoading(false);
        })
        .catch((e) => {
          if (!isDiffResultStillValid(workspaceId, version)) return;
          console.error("Failed to refresh diff files:", e);
          setDiffLoading(false);
        })
        .finally(() => {
          loadDiffInFlightCount.current -= 1;
        });
    }, 500);

    return () => clearTimeout(timer);
  }, [isRunning, selectedWorkspaceId, loadDiff, applyDiffResult, setDiffLoading, isDiffResultStillValid, isPendingPlaceholder]);

  // Idle polling: refresh diff while agent is not running so manually-edited
  // files and external git ops surface without navigating away. The cadence
  // is shared with the Files panel via `utils/pollingIntervals` so the two
  // stay in lockstep.
  useEffect(() => {
    if (!selectedWorkspaceId || isPendingPlaceholder || isRunning) return;
    const workspaceId = selectedWorkspaceId;

    const interval = setInterval(() => {
      // See active-polling effect above: skip tick when previous fetch is
      // still in flight. The 10s idle cadence rarely overlaps in practice,
      // but a concurrent `git fetch` can push merge-base latency past it.
      if (loadDiffInFlightCount.current > 0) return;
      const version = ++diffLoadVersion.current;
      loadDiffInFlightCount.current += 1;
      loadDiff(workspaceId)
        .then((result) => {
          if (!isDiffResultStillValid(workspaceId, version)) return;
          applyDiffResult(result);
        })
        .catch(() => {})
        .finally(() => {
          loadDiffInFlightCount.current -= 1;
        });
    }, IDLE_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isRunning, selectedWorkspaceId, loadDiff, applyDiffResult, isDiffResultStillValid, isPendingPlaceholder]);

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
    const canDiscard = localGitOpsEnabled && isDiscardableLayer(layer);
    const canStage = localGitOpsEnabled && (layer === "unstaged" || layer === "untracked");
    const canUnstage = localGitOpsEnabled && layer === "staged";
    // Deleted files don't exist on disk regardless of layer (staged deletions
    // are already removed by `git rm`; committed deletions are gone from HEAD).
    const canOpenSource = selectedWorkspaceId != null && file.status !== "Deleted";

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

    const handleStageClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canStage || gitOpInFlight) return;
      performStage(file.path).catch((err) => {
        console.error("Failed to stage file:", err);
      });
    };

    const handleUnstageClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canUnstage || gitOpInFlight) return;
      performUnstage(file.path).catch((err) => {
        console.error("Failed to unstage file:", err);
      });
    };

    const handleOpenClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canOpenSource || !selectedWorkspaceId) return;
      openFileTab(selectedWorkspaceId, file.path);
    };

    return (
    <div
      key={`${layer ?? "flat"}-${file.path}`}
      className={`${styles.file} ${isSelected ? styles.fileSelected : ""}`}
      onClick={() => {
        if (selectedWorkspaceId) {
          openDiffTab(selectedWorkspaceId, file.path, layer);
          setDiffSelectedCommitHash(null);
        }
      }}
      onContextMenu={handleContextMenu}
    >
      <span
        className={styles.status}
        style={{ color: statusColor(file.status) }}
      >
        {statusLabel(file.status)}
      </span>
      <span className={styles.path}>{file.path}</span>
      {(file.additions != null || file.deletions != null) && (
        <span className={styles.stats}>
          {file.additions != null && (
            <span className={styles.additions}>+{file.additions}</span>
          )}
          {file.deletions != null && (
            <span className={styles.deletions}>-{file.deletions}</span>
          )}
        </span>
      )}
      <span className={styles.rowActions}>
        {canOpenSource && (
          <button
            type="button"
            className={styles.rowAction}
            onClick={handleOpenClick}
            title="Open in editor"
            aria-label="Open in editor"
          >
            <FilePenLine size={12} />
          </button>
        )}
        {canStage && (
          <button
            type="button"
            className={styles.rowAction}
            onClick={handleStageClick}
            disabled={gitOpInFlight}
            title="Stage"
            aria-label="Stage"
          >
            <Plus size={12} />
          </button>
        )}
        {canUnstage && (
          <button
            type="button"
            className={styles.rowAction}
            onClick={handleUnstageClick}
            disabled={gitOpInFlight}
            title="Unstage"
            aria-label="Unstage"
          >
            <Minus size={12} />
          </button>
        )}
        {canDiscard && (
          <button
            type="button"
            className={`${styles.rowAction} ${styles.rowActionDanger}`}
            onClick={handleDiscardClick}
            disabled={gitOpInFlight}
            title={layer === "untracked" ? "Delete" : "Discard changes"}
            aria-label={layer === "untracked" ? "Delete" : "Discard changes"}
          >
            {layer === "untracked" ? (
              <Trash2 size={12} />
            ) : (
              <Undo2 size={12} />
            )}
          </button>
        )}
      </span>
    </div>
    );
  };

  // Wraps a stage/unstage/discard body so concurrent invocations are blocked
  // (the in-flight flag also dims every action button) and the resulting
  // diff reload is dropped if the user switched workspaces while git was
  // running. Errors propagate so callers can surface them — discard hands
  // them to the confirm modal; fire-and-forget click handlers log them.
  const runIndexOp = useCallback(
    async (op: () => Promise<void>) => {
      if (!worktreePath || !selectedWorkspaceId) return;
      if (gitOpInFlight) return;
      setGitOpInFlight(true);
      try {
        await op();
        const result = await loadDiff(selectedWorkspaceId);
        if (useAppStore.getState().selectedWorkspaceId === selectedWorkspaceId) {
          applyDiffResult(result);
          requestFileTreeRefresh(selectedWorkspaceId);
        }
      } finally {
        setGitOpInFlight(false);
      }
    },
    [
      worktreePath,
      selectedWorkspaceId,
      loadDiff,
      applyDiffResult,
      requestFileTreeRefresh,
      gitOpInFlight,
    ],
  );

  // Clear the diff selection when the currently-selected row is about to
  // move between layers (stage/unstage) or disappear (discard). Without
  // this, `diffSelectedLayer` keeps pointing at the now-empty old layer,
  // which leaves the sidebar with no highlighted row and the diff viewer
  // showing stale content.
  const clearSelectionIfAffected = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    const state = useAppStore.getState();
    const selected = state.diffSelectedFile;
    if (selected && paths.includes(selected)) {
      state.setDiffSelectedFile(null);
    }
  }, []);

  const performStage = useCallback(
    (filePath: string) =>
      runIndexOp(async () => {
        clearSelectionIfAffected([filePath]);
        await stageFile(worktreePath!, filePath);
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
  );

  const performUnstage = useCallback(
    (filePath: string) =>
      runIndexOp(async () => {
        clearSelectionIfAffected([filePath]);
        await unstageFile(worktreePath!, filePath);
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
  );

  const performStageAll = useCallback(
    (files: DiffFile[]) =>
      runIndexOp(async () => {
        if (files.length === 0) return;
        const paths = files.map((f) => f.path);
        clearSelectionIfAffected(paths);
        // One git invocation with all paths — parallel `git add`s race on
        // `.git/index.lock` and would fail.
        await stageFiles(worktreePath!, paths);
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
  );

  const performUnstageAll = useCallback(
    (files: DiffFile[]) =>
      runIndexOp(async () => {
        if (files.length === 0) return;
        const paths = files.map((f) => f.path);
        clearSelectionIfAffected(paths);
        await unstageFiles(worktreePath!, paths);
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
  );

  const performBulkDiscard = useCallback(
    (files: DiffFile[], layer: DiscardableLayer) =>
      runIndexOp(async () => {
        if (files.length === 0) return;
        const isUntracked = layer === "untracked";
        const paths = files.map((f) => f.path);
        clearSelectionIfAffected(paths);
        await discardFiles(
          worktreePath!,
          isUntracked ? [] : paths,
          isUntracked ? paths : [],
        );
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
  );

  const performDiscard = useCallback(
    (filePath: string, layer: DiscardableLayer) =>
      runIndexOp(async () => {
        clearSelectionIfAffected([filePath]);
        await discardFile(worktreePath!, filePath, layer === "untracked");
      }),
    [runIndexOp, clearSelectionIfAffected, worktreePath],
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
          className={`${styles.tab} ${activeTab === "files" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("files")}
        >
          Files
        </button>
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
      </div>

      {activeTab === "files" && <FilesPanel />}

      {activeTab === "changes" && (
        <>
          <div className={styles.list}>
            {diffFiles.length === 0 && diffLoading ? (
              <div className={styles.empty}>Loading...</div>
            ) : diffFiles.length === 0 ? (
              <div className={styles.empty}>No changes</div>
            ) : hasGrouped ? (
              // Key the group block on the active workspace so per-group
              // collapse state (held in FileGroup's local useState) resets
              // when the user switches workspaces — otherwise expanding
              // "Committed" in workspace A would carry into workspace B.
              <Fragment key={selectedWorkspaceId ?? ""}>
                <FileGroup
                  label="Staged"
                  files={diffStagedFiles!.staged}
                  layer="staged"
                  accentColor="var(--accent-dim)"
                  renderFileRow={renderFileRow}
                  onUnstageAll={
                    localGitOpsEnabled
                      ? () => {
                          performUnstageAll(diffStagedFiles!.staged).catch((err) => {
                            console.error("Failed to unstage all files:", err);
                          });
                        }
                      : undefined
                  }
                  disabled={gitOpInFlight}
                />
                <FileGroup
                  label="Unstaged"
                  files={diffStagedFiles!.unstaged}
                  layer="unstaged"
                  accentColor="var(--tool-task)"
                  renderFileRow={renderFileRow}
                  onStageAll={
                    localGitOpsEnabled
                      ? () => {
                          performStageAll(diffStagedFiles!.unstaged).catch((err) => {
                            console.error("Failed to stage all files:", err);
                          });
                        }
                      : undefined
                  }
                  onDiscardAll={
                    localGitOpsEnabled
                      ? () =>
                          setBulkDiscardTarget({
                            files: diffStagedFiles!.unstaged,
                            layer: "unstaged",
                          })
                      : undefined
                  }
                  disabled={gitOpInFlight}
                />
                <FileGroup
                  label="Untracked"
                  files={diffStagedFiles!.untracked}
                  layer="untracked"
                  accentColor="var(--text-dim)"
                  renderFileRow={renderFileRow}
                />
                <FileGroup
                  label="Committed"
                  files={diffStagedFiles!.committed}
                  layer="committed"
                  accentColor="var(--diff-added-text)"
                  renderFileRow={renderFileRow}
                />
                {commitHistory && commitHistory.length > 0 && (
                  <CommitGroup
                    commits={commitHistory}
                    selectedFile={diffSelectedFile}
                    selectedCommitHash={diffSelectedCommitHash}
                    selectedWorkspaceId={selectedWorkspaceId}
                    openFileTab={openFileTab}
                    onFileClick={(file, commitHash) => {
                      if (selectedWorkspaceId) {
                        openDiffTab(selectedWorkspaceId, file.path, "committed");
                        setDiffSelectedCommitHash(commitHash);
                      }
                    }}
                  />
                )}
              </Fragment>
            ) : (
              // Fallback: flat list (remote server without staged_files)
              diffFiles.map((file) => renderFileRow(file))
            )}
          </div>
        </>
      )}

      {activeTab === "tasks" && (
        selectedWorkspaceId
          ? <TaskList taskHistory={taskHistory} />
          : <div className={styles.list}><div className={styles.empty}>No workspace selected</div></div>
      )}

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

      {bulkDiscardTarget && (
        <DiscardChangesConfirm
          bulkCount={bulkDiscardTarget.files.length}
          layer={bulkDiscardTarget.layer}
          onConfirm={() =>
            performBulkDiscard(bulkDiscardTarget.files, bulkDiscardTarget.layer)
          }
          onClose={() => setBulkDiscardTarget(null)}
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
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  disabled,
}: {
  label: string;
  files: DiffFile[];
  layer: DiffLayer;
  accentColor: string;
  renderFileRow: (file: DiffFile, layer?: DiffLayer) => React.ReactElement;
  onStageAll?: () => void;
  onUnstageAll?: () => void;
  onDiscardAll?: () => void;
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(layer === "committed");

  if (files.length === 0) return null;

  const hasActions = onStageAll != null || onUnstageAll != null || onDiscardAll != null;

  return (
    <div
      className={styles.fileGroup}
      style={{ borderLeftColor: accentColor }}
    >
      <div className={styles.groupHeader}>
        <button
          type="button"
          className={styles.groupToggle}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronRight
            size={12}
            className={`${styles.groupChevron} ${!collapsed ? styles.groupChevronOpen : ""}`}
          />
          <span className={styles.groupLabel}>{label}</span>
          <span className={styles.groupCount}>{files.length}</span>
        </button>
        {hasActions && (
          <span className={styles.groupActions}>
            {onStageAll && (
              <button
                type="button"
                className={styles.groupAction}
                onClick={onStageAll}
                disabled={disabled}
                title="Stage all"
                aria-label="Stage all"
              >
                <Plus size={12} />
              </button>
            )}
            {onUnstageAll && (
              <button
                type="button"
                className={styles.groupAction}
                onClick={onUnstageAll}
                disabled={disabled}
                title="Unstage all"
                aria-label="Unstage all"
              >
                <Minus size={12} />
              </button>
            )}
            {onDiscardAll && (
              <button
                type="button"
                className={`${styles.groupAction} ${styles.groupActionDanger}`}
                onClick={onDiscardAll}
                disabled={disabled}
                title="Discard all"
                aria-label="Discard all"
              >
                <Undo2 size={12} />
              </button>
            )}
          </span>
        )}
      </div>
      {!collapsed && files.map((file) => renderFileRow(file, layer))}
    </div>
  );
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
  return `${Math.floor(diffDays / 365)}y`;
}

function CommitGroup({
  commits,
  selectedFile,
  selectedCommitHash,
  selectedWorkspaceId,
  openFileTab,
  onFileClick,
}: {
  commits: CommitEntry[];
  selectedFile: string | null;
  selectedCommitHash: string | null;
  selectedWorkspaceId: string | null;
  openFileTab: (workspaceId: string, path: string) => void;
  onFileClick: (file: DiffFile, commitHash: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [expandedHashes, setExpandedHashes] = useState<Record<string, boolean>>({});

  const toggleCommit = (hash: string) => {
    setExpandedHashes((prev) => ({ ...prev, [hash]: !prev[hash] }));
  };

  return (
    <div
      className={styles.fileGroup}
      style={{ borderLeftColor: "var(--diff-added-text)" }}
    >
      <button
        className={styles.groupHeader}
        onClick={() => setCollapsed(!collapsed)}
      >
        <ChevronRight
          size={12}
          className={`${styles.groupChevron} ${!collapsed ? styles.groupChevronOpen : ""}`}
        />
        <span className={styles.groupLabel}>Commits</span>
        <span className={styles.groupCount}>{commits.length}</span>
      </button>
      {!collapsed &&
        commits.map((commit) => (
          <div key={commit.hash} className={styles.commitItem}>
            <button
              className={`${styles.commitRow} ${selectedCommitHash === commit.hash && expandedHashes[commit.hash] ? styles.commitRowActive : ""}`}
              onClick={() => toggleCommit(commit.hash)}
            >
              <ChevronRight
                size={10}
                className={`${styles.commitChevron} ${expandedHashes[commit.hash] ? styles.groupChevronOpen : ""}`}
              />
              <span className={styles.commitHash}>{commit.short_hash}</span>
              <span className={styles.commitSubject}>{commit.subject}</span>
              <span className={styles.commitDate}>{formatRelativeDate(commit.date)}</span>
            </button>
            {expandedHashes[commit.hash] && (
              <div className={styles.commitFiles}>
                {commit.files.length === 0 ? (
                  <div className={styles.commitNoFiles}>no file changes</div>
                ) : (
                  commit.files.map((file) => {
                    const isSelected =
                      selectedFile === file.path &&
                      selectedCommitHash === commit.hash;
                    const canOpen = selectedWorkspaceId != null && file.status !== "Deleted";
                    return (
                      <div
                        key={file.path}
                        className={`${styles.file} ${styles.commitFileRow} ${isSelected ? styles.fileSelected : ""}`}
                        onClick={() => onFileClick(file, commit.hash)}
                      >
                        <span
                          className={styles.status}
                          style={{
                            color:
                              typeof file.status === "string"
                                ? file.status === "Added"
                                  ? "var(--diff-added-text)"
                                  : file.status === "Modified"
                                    ? "var(--tool-task)"
                                    : "var(--diff-removed-text)"
                                : "var(--diff-hunk-header)",
                          }}
                        >
                          {typeof file.status === "string"
                            ? file.status === "Added"
                              ? "A"
                              : file.status === "Modified"
                                ? "M"
                                : "D"
                            : "R"}
                        </span>
                        <span className={styles.path}>{file.path}</span>
                        {(file.additions != null || file.deletions != null) && (
                          <span className={styles.stats}>
                            {file.additions != null && (
                              <span className={styles.additions}>+{file.additions}</span>
                            )}
                            {file.deletions != null && (
                              <span className={styles.deletions}>-{file.deletions}</span>
                            )}
                          </span>
                        )}
                        <span className={styles.rowActions}>
                          {canOpen && (
                            <button
                              type="button"
                              className={styles.rowAction}
                              onClick={(e) => {
                                e.stopPropagation();
                                openFileTab(selectedWorkspaceId, file.path);
                              }}
                              title="Open in editor"
                              aria-label="Open in editor"
                            >
                              <FilePenLine size={12} />
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
