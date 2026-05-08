import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useAppStore } from "../../stores/useAppStore";
import { listWorkspaceFiles, type FileEntry } from "../../services/tauri";
import { resolveHotkeyAction } from "../../hotkeys/bindings";
import { isAgentBusy } from "../../utils/agentStatus";
import {
  FILES_AGENT_RUNNING_INTERVAL_MS,
  IDLE_REFRESH_INTERVAL_MS,
} from "../../utils/pollingIntervals";
import type { DiffLayer } from "../../types/diff";
import { FilePathContextMenu } from "./FilePathContextMenu";
import type { FileContextTarget } from "./fileContextMenu";
import { FileTree } from "./FileTree";
import { useFilePathActions } from "./useFilePathActions";
import styles from "./FilesPanel.module.css";

export function FilesPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const refreshNonce = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.fileTreeRefreshNonceByWorkspace[selectedWorkspaceId] ?? 0)
      : 0,
  );
  // Bumped when a global hotkey (Cmd/Ctrl+T while a file is the active
  // workspace tab) requests "new file at workspace root" — the panel is
  // the inline-editor owner so the request lands here, not in the
  // hotkey handler. We only react when a file tab is actually active so
  // a Cmd+T pressed in chat context (which never bumps this nonce) can't
  // accidentally drop the user into a "create file" flow.
  const newFileNonce = useAppStore((s) =>
    selectedWorkspaceId
      ? (s.requestNewFileNonceByWorkspace[selectedWorkspaceId] ?? 0)
      : 0,
  );
  const openFileTab = useAppStore((s) => s.openFileTab);
  const openDiffTab = useAppStore((s) => s.openDiffTab);
  const setDiffSelectedCommitHash = useAppStore((s) => s.setDiffSelectedCommitHash);
  const setAllFilesDirExpanded = useAppStore((s) => s.setAllFilesDirExpanded);
  const keybindings = useAppStore((s) => s.keybindings);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    target: FileContextTarget;
    x: number;
    y: number;
  } | null>(null);
  const [renamingTarget, setRenamingTarget] = useState<FileContextTarget | null>(
    null,
  );
  const [creatingParentPath, setCreatingParentPath] = useState<string | null>(
    null,
  );
  const [focusRequest, setFocusRequest] = useState(0);
  const loadVersionRef = useRef(0);
  const prevIsRunning = useRef(false);
  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const isRunning = isAgentBusy(ws?.agent_status);
  const filePathActions = useFilePathActions(selectedWorkspaceId ?? "");
  const refocusExplorer = useCallback(() => {
    setFocusRequest((request) => request + 1);
  }, []);

  const loadFiles = useCallback(
    async (workspaceId: string, showLoading: boolean) => {
      const version = ++loadVersionRef.current;
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      try {
        const result = await listWorkspaceFiles(workspaceId);
        if (version !== loadVersionRef.current) return;
        if (useAppStore.getState().selectedWorkspaceId !== workspaceId) return;
        setEntries(result);
        setLoading(false);
      } catch (e) {
        if (version !== loadVersionRef.current) return;
        if (useAppStore.getState().selectedWorkspaceId !== workspaceId) return;
        setError(String(e));
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedWorkspaceId) {
      loadVersionRef.current += 1;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadFiles(selectedWorkspaceId, true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedWorkspaceId, refreshNonce, loadFiles]);

  useEffect(() => {
    if (!selectedWorkspaceId || !isRunning) return;
    const interval = setInterval(() => {
      void loadFiles(selectedWorkspaceId, false);
    }, FILES_AGENT_RUNNING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning, selectedWorkspaceId, loadFiles]);

  useEffect(() => {
    const wasRunning = prevIsRunning.current;
    prevIsRunning.current = isRunning;
    if (!selectedWorkspaceId || wasRunning !== true || isRunning) return;

    const timer = setTimeout(() => {
      void loadFiles(selectedWorkspaceId, false);
    }, 500);
    return () => clearTimeout(timer);
  }, [isRunning, selectedWorkspaceId, loadFiles]);

  // Idle polling: refresh file tree while agent is not running so
  // manually-edited files surface without navigating away. The cadence
  // lives in `utils/pollingIntervals` alongside the diff panel's idle
  // interval so the two stay in lockstep — see that module for the
  // full three-tier rationale.
  useEffect(() => {
    if (!selectedWorkspaceId || isRunning) return;
    const interval = setInterval(() => {
      void loadFiles(selectedWorkspaceId, false);
    }, IDLE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning, selectedWorkspaceId, loadFiles]);

  // React to the `requestNewFileAtRoot` nonce: open the inline create
  // editor at the workspace root. The first effect run (nonce === 0) is
  // skipped on purpose so opening a workspace doesn't auto-trigger the
  // create flow.
  const lastSeenNewFileNonce = useRef(newFileNonce);
  useEffect(() => {
    if (newFileNonce === lastSeenNewFileNonce.current) return;
    lastSeenNewFileNonce.current = newFileNonce;
    if (!selectedWorkspaceId) return;
    setCreatingParentPath("");
    refocusExplorer();
  }, [newFileNonce, selectedWorkspaceId, refocusExplorer]);

  const handleActivateFile = useCallback(
    (path: string) => {
      // With tabs, opening a file is unconditional: either it's already
      // open (we just select it) or it's new (we add the tab). Buffers are
      // preserved across tab switches in the store, so there's no risk of
      // losing unsaved edits on click. The discard-changes prompt now
      // lives on the tab's close button instead.
      if (!selectedWorkspaceId) return;
      openFileTab(selectedWorkspaceId, path);
    },
    [selectedWorkspaceId, openFileTab],
  );

  const handleActivateDiff = useCallback(
    (path: string, layer: DiffLayer | null) => {
      if (!selectedWorkspaceId) return;
      openDiffTab(selectedWorkspaceId, path, layer);
      setDiffSelectedCommitHash(null);
    },
    [selectedWorkspaceId, openDiffTab, setDiffSelectedCommitHash],
  );

  const handlePanelKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!selectedWorkspaceId || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) {
        return;
      }
      if (
        resolveHotkeyAction(event.nativeEvent, "file-viewer", keybindings) !==
        "file-viewer.undo-file-operation"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void filePathActions.undoLastFilePathOperation();
    },
    [filePathActions, keybindings, selectedWorkspaceId],
  );

  if (!selectedWorkspaceId) {
    return <div className={styles.empty}>No workspace selected</div>;
  }

  return (
    <div className={styles.panel} onKeyDownCapture={handlePanelKeyDownCapture}>
      {loading ? (
        <div className={styles.empty}>Loading…</div>
      ) : error ? (
        <div className={styles.empty}>Failed to load: {error}</div>
      ) : (
        <FileTree
          workspaceId={selectedWorkspaceId}
          entries={entries}
          onActivateFile={handleActivateFile}
          onActivateDiff={handleActivateDiff}
          onContextMenu={(target, x, y) => setContextMenu({ target, x, y })}
          creatingParentPath={creatingParentPath}
          focusRequest={focusRequest}
          onCreateCommit={async (parentPath, name) => {
            try {
              await filePathActions.createFile(parentPath, name);
              setCreatingParentPath(null);
              refocusExplorer();
              return true;
            } catch (err) {
              console.error("Failed to create file:", err);
              useAppStore.getState().addToast(`Create file failed: ${String(err)}`);
              return false;
            }
          }}
          onCreateCancel={() => {
            setCreatingParentPath(null);
            refocusExplorer();
          }}
          renamingPath={renamingTarget?.path ?? null}
          onRenameCommit={async (target, newName) => {
            try {
              await filePathActions.renamePath(target, newName);
              setRenamingTarget(null);
              refocusExplorer();
              return true;
            } catch (err) {
              console.error("Failed to rename file:", err);
              useAppStore.getState().addToast(`Rename failed: ${String(err)}`);
              return false;
            }
          }}
          onRenameCancel={() => {
            setRenamingTarget(null);
            refocusExplorer();
          }}
        />
      )}
      {contextMenu && (
        <FilePathContextMenu
          workspaceId={selectedWorkspaceId}
          target={contextMenu.target}
          x={contextMenu.x}
          y={contextMenu.y}
          onCreateFileRequest={(parentPath) => {
            const clean = parentPath.replace(/\/+$/g, "");
            if (clean) {
              setAllFilesDirExpanded(selectedWorkspaceId, `${clean}/`, true);
            }
            setCreatingParentPath(clean);
          }}
          onRenameRequest={(target) => setRenamingTarget(target)}
          onOperationComplete={refocusExplorer}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
