import { useMemo, type MutableRefObject } from "react";
import type { editor as MonacoNs } from "monaco-editor";
import { useAppStore } from "../../../stores/useAppStore";
import { fileBufferKey } from "../../../stores/slices/fileTreeSlice";
import { setAppSetting } from "../../../services/tauri";
import type { EditorActions } from "./editorMenuConfig";

/** Base Monaco font size — must stay in sync with the `fontSize: 13`
 *  literal in `MonacoEditor.tsx`. The View > Zoom items multiply this
 *  by `editorFontZoom` and call `editor.updateOptions({ fontSize })`. */
export const EDITOR_BASE_FONT_SIZE = 13;
export const EDITOR_ZOOM_STEP = 0.1;
export const EDITOR_ZOOM_MIN = 0.7;
export const EDITOR_ZOOM_MAX = 2;

/** Pure dependency bag consumed by `buildEditorActions`. Refactoring all
 *  side effects through this interface lets the hook stay a thin store
 *  selector while tests can pass hand-rolled mocks. */
export interface EditorActionsDeps {
  workspaceId: string;
  path: string;
  /** Snapshot of the live editor. `null` when Monaco hasn't mounted yet
   *  or the editor is showing markdown preview / image. Each handler
   *  null-guards against that case. */
  editor: MonacoNs.IStandaloneCodeEditor | null;
  /** FileViewer's existing save + close handlers — we route through
   *  them so the dirty-aware confirmation modal and save toast are
   *  shared with the inline Save button. */
  onSave: () => void;
  onCloseTab: () => void;

  /** Current saved-baseline for the open file. `null` when the buffer
   *  hasn't loaded yet. Revert restores the editor buffer to this. */
  getBaseline: () => string | null;
  setFileBufferContent: (workspaceId: string, path: string, value: string) => void;

  /** Reveal-in-files plumbing. */
  setAllFilesSelectedPath: (workspaceId: string, path: string | null) => void;
  setAllFilesDirExpanded: (
    workspaceId: string,
    path: string,
    expanded: boolean,
  ) => void;
  rightSidebarVisible: boolean;
  showRightSidebar: () => void;
  setRightSidebarTab: (tab: "files" | "changes" | "tasks") => void;

  openCommandPaletteFileMode: () => void;

  /** Editor view-state — Monaco subscribes to the store values and
   *  applies them via `updateOptions`. The action just flips the
   *  underlying flag + persists. */
  wordWrap: boolean;
  setWordWrap: (val: boolean) => void;
  minimap: boolean;
  setMinimap: (val: boolean) => void;
  lineNumbers: boolean;
  setLineNumbers: (val: boolean) => void;
  fontZoom: number;
  setFontZoom: (val: number) => void;

  /** `setAppSetting` indirection — kept here so the hook can ignore
   *  Tauri import boundaries during tests. Failures are logged but not
   *  surfaced as toasts; the in-memory store update is the authoritative
   *  signal for the menubar UX and matches the existing
   *  `EditorSettings.tsx` rollback approach for the minimap toggle. */
  persistSetting: (key: string, value: string) => Promise<unknown>;

  /** Absolute path on disk to the workspace root, for Copy Path. `null`
   *  if the workspace has no worktree yet (remote, in-progress
   *  provisioning) — Copy Path falls back to the relative path in that
   *  case so the menu item still does something useful. */
  worktreePath: string | null;
  writeToClipboard: (text: string) => Promise<void>;
  addToast: (message: string) => void;
}

/** Join a worktree root and a workspace-relative path so the result is
 *  usable from a shell ("paste into terminal"). Handles trailing /
 *  separators on the root and an accidentally absolute relative path. */
export function joinWorktreePath(root: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${trimmed}/${relative}`;
}

/** Step out of every parent segment of a workspace-relative path so
 *  Reveal-in-Files can expand them in the tree. Returns parents in
 *  outer-to-inner order (`["src", "src/components", "src/components/foo"]`). */
export function ancestorDirs(relative: string): string[] {
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const acc: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    acc.push(parts.slice(0, i).join("/"));
  }
  return acc;
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, value));
}

/** Build the handler bag consumed by `buildEditorMenus`. Pure with
 *  respect to its `deps` — every observable effect is delegated to the
 *  passed-in functions/refs, so unit tests can swap in spies. */
export function buildEditorActions(deps: EditorActionsDeps): EditorActions {
  const runMonacoAction = (actionId: string) => {
    const editor = deps.editor;
    if (!editor) return;
    const action = editor.getAction(actionId);
    if (action) void action.run();
  };

  const triggerMonacoCommand = (commandId: string) => {
    deps.editor?.trigger("editor-menubar", commandId, null);
  };

  const onRevert = () => {
    const baseline = deps.getBaseline();
    if (baseline === null) return;
    deps.setFileBufferContent(deps.workspaceId, deps.path, baseline);
  };

  const onRevealInFiles = () => {
    if (!deps.rightSidebarVisible) deps.showRightSidebar();
    deps.setRightSidebarTab("files");
    for (const dir of ancestorDirs(deps.path)) {
      deps.setAllFilesDirExpanded(deps.workspaceId, dir, true);
    }
    deps.setAllFilesSelectedPath(deps.workspaceId, deps.path);
  };

  const persistFireAndForget = (key: string, value: string) => {
    void deps.persistSetting(key, value).catch((err) => {
      // We intentionally don't roll the store back — losing a single
      // persistence write is a far better UX than a flicker. The error
      // lands in the console so it can still be diagnosed.
      console.error(`Failed to persist editor setting ${key}:`, err);
    });
  };

  const onToggleWordWrap = () => {
    const next = !deps.wordWrap;
    deps.setWordWrap(next);
    persistFireAndForget("editor_word_wrap", next ? "true" : "false");
  };

  const onToggleMinimap = () => {
    const next = !deps.minimap;
    deps.setMinimap(next);
    persistFireAndForget("editor_minimap_enabled", next ? "true" : "false");
  };

  const onToggleLineNumbers = () => {
    const next = !deps.lineNumbers;
    deps.setLineNumbers(next);
    persistFireAndForget("editor_line_numbers", next ? "true" : "false");
  };

  const applyZoom = (nextZoom: number) => {
    const clamped = clampZoom(nextZoom);
    deps.setFontZoom(clamped);
    persistFireAndForget("editor_font_zoom", clamped.toFixed(2));
  };

  const onZoomIn = () => applyZoom(deps.fontZoom + EDITOR_ZOOM_STEP);
  const onZoomOut = () => applyZoom(deps.fontZoom - EDITOR_ZOOM_STEP);
  const onZoomReset = () => applyZoom(1);

  const onCopyContents = async () => {
    const editor = deps.editor;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const value = model.getValue();
    try {
      await deps.writeToClipboard(value);
      deps.addToast("Copied file contents");
    } catch (err) {
      console.error("Copy contents failed:", err);
      deps.addToast(`Copy failed: ${String(err)}`);
    }
  };

  const onCopyPath = async () => {
    const target = deps.worktreePath
      ? joinWorktreePath(deps.worktreePath, deps.path)
      : deps.path;
    try {
      await deps.writeToClipboard(target);
      deps.addToast("Copied path");
    } catch (err) {
      console.error("Copy path failed:", err);
      deps.addToast(`Copy failed: ${String(err)}`);
    }
  };

  const onCopyRelativePath = async () => {
    try {
      await deps.writeToClipboard(deps.path);
      deps.addToast("Copied relative path");
    } catch (err) {
      console.error("Copy relative path failed:", err);
      deps.addToast(`Copy failed: ${String(err)}`);
    }
  };

  return {
    onSave: deps.onSave,
    onRevert,
    onRevealInFiles,
    onCloseTab: deps.onCloseTab,
    onUndo: () => triggerMonacoCommand("undo"),
    onRedo: () => triggerMonacoCommand("redo"),
    onFind: () => runMonacoAction("actions.find"),
    onReplace: () => runMonacoAction("editor.action.startFindReplaceAction"),
    onFormat: () => runMonacoAction("editor.action.formatDocument"),
    onCopyContents,
    onCopyPath,
    onCopyRelativePath,
    onToggleWordWrap,
    onToggleMinimap,
    onToggleLineNumbers,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onGoToFile: deps.openCommandPaletteFileMode,
    onGoToLine: () => runMonacoAction("editor.action.gotoLine"),
    onGoToSymbol: () => runMonacoAction("editor.action.quickOutline"),
  };
}

interface UseEditorActionsParams {
  workspaceId: string;
  path: string;
  editorRef: MutableRefObject<MonacoNs.IStandaloneCodeEditor | null>;
  onSave: () => void;
  onCloseTab: () => void;
}

/** React hook that wires `buildEditorActions` to the live store + Tauri
 *  surface. Keep this thin — all logic lives in `buildEditorActions`. */
export function useEditorActions(params: UseEditorActionsParams): EditorActions {
  const { workspaceId, path, editorRef, onSave, onCloseTab } = params;

  const setFileBufferContent = useAppStore((s) => s.setFileBufferContent);
  const setAllFilesSelectedPath = useAppStore((s) => s.setAllFilesSelectedPath);
  const setAllFilesDirExpanded = useAppStore((s) => s.setAllFilesDirExpanded);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab);
  const openCommandPaletteFileMode = useAppStore(
    (s) => s.openCommandPaletteFileMode,
  );
  const wordWrap = useAppStore((s) => s.editorWordWrap);
  const setWordWrap = useAppStore((s) => s.setEditorWordWrap);
  const minimap = useAppStore((s) => s.editorMinimapEnabled);
  const setMinimap = useAppStore((s) => s.setEditorMinimapEnabled);
  const lineNumbers = useAppStore((s) => s.editorLineNumbersEnabled);
  const setLineNumbers = useAppStore((s) => s.setEditorLineNumbersEnabled);
  const fontZoom = useAppStore((s) => s.editorFontZoom);
  const setFontZoom = useAppStore((s) => s.setEditorFontZoom);
  const addToast = useAppStore((s) => s.addToast);
  const worktreePath = useAppStore(
    (s) =>
      s.workspaces.find((w) => w.id === workspaceId)?.worktree_path ?? null,
  );

  return useMemo(
    () =>
      buildEditorActions({
        workspaceId,
        path,
        editor: editorRef.current,
        onSave,
        onCloseTab,
        getBaseline: () => {
          const buf = useAppStore.getState().fileBuffers[
            fileBufferKey(workspaceId, path)
          ];
          return buf && buf.loaded ? buf.baseline : null;
        },
        setFileBufferContent,
        setAllFilesSelectedPath,
        setAllFilesDirExpanded,
        rightSidebarVisible,
        showRightSidebar: () => {
          if (!useAppStore.getState().rightSidebarVisible) toggleRightSidebar();
        },
        setRightSidebarTab,
        openCommandPaletteFileMode,
        wordWrap,
        setWordWrap,
        minimap,
        setMinimap,
        lineNumbers,
        setLineNumbers,
        fontZoom,
        setFontZoom,
        persistSetting: (key, value) => setAppSetting(key, value),
        worktreePath,
        writeToClipboard: (text) =>
          navigator.clipboard.writeText(text).then(() => {}),
        addToast,
      }),
    [
      workspaceId,
      path,
      editorRef,
      onSave,
      onCloseTab,
      setFileBufferContent,
      setAllFilesSelectedPath,
      setAllFilesDirExpanded,
      rightSidebarVisible,
      toggleRightSidebar,
      setRightSidebarTab,
      openCommandPaletteFileMode,
      wordWrap,
      setWordWrap,
      minimap,
      setMinimap,
      lineNumbers,
      setLineNumbers,
      fontZoom,
      setFontZoom,
      worktreePath,
      addToast,
    ],
  );
}
