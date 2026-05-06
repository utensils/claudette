import { memo, useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import "./monacoSetup";
import { applyMonacoTheme, initMonacoThemeSync } from "./monacoTheme";
import { DEFAULT_MONO_STACK } from "../../styles/fonts";
import { useAppStore } from "../../stores/useAppStore";
import {
  AttachmentContextMenu,
  type AttachmentContextMenuItem,
} from "../chat/AttachmentContextMenu";
import {
  useGitGutter,
  type DecorationsCollection,
} from "./useGitGutter";
import styles from "./MonacoEditor.module.css";

interface MonacoEditorProps {
  /** Workspace id used to scope HEAD-blob lookups for the git gutter. */
  workspaceId: string;
  /** Initial document text. The parent uses `key={path}` so that switching
   *  files remounts the editor with a fresh undo history; mode toggles
   *  (view↔edit) reuse the same instance via `updateOptions`. */
  initialValue: string;
  /** File path used to derive the language id. Monaco's built-in detection
   *  works off URI extensions, so we pass the path through as a `path` prop
   *  and let Monaco pick the language. */
  filename: string;
  /** Read-only mode. Toggled at runtime via `updateOptions` so flipping
   *  view/edit doesn't lose cursor position or undo stack. */
  readOnly: boolean;
  /** Fired on every document change. The parent compares against the
   *  baseline to update the per-tab dirty flag. */
  onChange: (value: string) => void;
  /** Save callback bound to Cmd/Ctrl+S. The shortcut fires only when the
   *  editor has focus, matching the spec. */
  onSave?: () => void;
}

export const MonacoEditor = memo(function MonacoEditor({
  workspaceId,
  initialValue,
  filename,
  readOnly,
  onChange,
  onSave,
}: MonacoEditorProps) {
  // Stash the latest callbacks in refs so the editor doesn't need to be
  // re-mounted just because they changed identity. Monaco's command
  // handlers and onChange wiring close over these refs, not the props
  // directly, which keeps re-renders cheap during typing.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cleanupThemeSyncRef = useRef<(() => void) | null>(null);
  // Owned by this component so the git-gutter hook can read it on mount.
  // Created in `handleMount` once Monaco has resolved — that's the only
  // point where `editor.createDecorationsCollection()` is callable. A
  // `[]`-deps effect inside the hook would run *before* the lazy-loaded
  // editor mounts, so the collection has to be initialized here.
  const gutterCollectionRef = useRef<DecorationsCollection | null>(null);

  // Mirror the editor's text into React state so the git-gutter hook can
  // recompute on every change. Seeded from `initialValue`; the parent
  // remounts via `key={path}` on file switches so the seed stays correct.
  const [currentBuffer, setCurrentBuffer] = useState(initialValue);

  // Right-click position for our portal context menu. Monaco's built-in menu
  // ignores html `zoom` and lands offset from the cursor; we disable it via
  // the `contextmenu: false` option below and route right-clicks through
  // `AttachmentContextMenu`, which already compensates for engine-specific
  // event-coord semantics. See utils/zoom.ts for the engine probe.
  const [editorMenu, setEditorMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  const minimapEnabled = useAppStore((s) => s.editorMinimapEnabled);

  // Reflect readOnly changes into the editor without remounting. Monaco's
  // `updateOptions` is the explicit runtime API for this; with CodeMirror
  // we had to recreate EditorState, but here it's a one-liner.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: minimapEnabled } });
  }, [minimapEnabled]);

  // Disconnect the theme observer and clear the gutter collection when
  // the editor unmounts. The collection is owned by Monaco's editor
  // instance, which is itself disposed by the `<Editor>` component, but
  // null-ing the ref is cheap insurance against stale reads.
  useEffect(
    () => () => {
      cleanupThemeSyncRef.current?.();
      gutterCollectionRef.current?.clear();
      gutterCollectionRef.current = null;
    },
    [],
  );

  // Define the 'claudette' theme before the editor instance is created so
  // the theme prop resolves immediately and there's no flash of vs-dark.
  const handleBeforeMount: BeforeMount = (monacoInstance) => {
    applyMonacoTheme(monacoInstance);
  };

  const handleMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
    monacoRef.current = monacoInstance;
    // Initialize the gutter decoration collection now that Monaco has
    // handed us a live editor. The collection survives buffer/file
    // changes within the same mount; the parent remounts on file
    // switches via `key={path}`, so a fresh collection is created per
    // file.
    gutterCollectionRef.current = editor.createDecorationsCollection();
    // Start live theme sync: re-derives the Monaco theme whenever the
    // Claudette theme changes (data-theme attribute or inline CSS vars).
    cleanupThemeSyncRef.current = initMonacoThemeSync(monacoInstance);
    // Bind Cmd/Ctrl+S as an editor command. Monaco scopes these to the
    // editor's focus, so the shortcut won't fire from outside the editor —
    // matches the spec and avoids stomping the platform-native save.
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
      () => onSaveRef.current?.(),
    );
    // Replace Monaco's built-in context menu with our portal-mounted one.
    // The DOM listener has to live on the editor's outer node so it fires
    // for clicks anywhere inside (gutter included) — capture-phase to win
    // against any inner handler. Monaco still owns the actions; we just
    // own the chrome.
    const dom = editor.getDomNode();
    if (dom) {
      const onContext = (e: MouseEvent) => {
        // Drive selection from the click before opening the menu, mirroring
        // what Monaco's own menu does. Without this, "Cut" / "Copy" would
        // run against whatever was selected before — surprising on a fresh
        // right-click into empty whitespace.
        const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
        if (target?.position) {
          const sel = editor.getSelection();
          const inSel =
            sel && !sel.isEmpty() && sel.containsPosition(target.position);
          if (!inSel) {
            editor.setPosition(target.position);
            editor.focus();
          }
        }
        e.preventDefault();
        e.stopPropagation();
        setEditorMenu({ x: e.clientX, y: e.clientY });
      };
      dom.addEventListener("contextmenu", onContext, true);
      // Stash the cleanup on the editor instance via a disposable so the
      // existing unmount path tears it down without a separate ref.
      editor.onDidDispose(() => {
        dom.removeEventListener("contextmenu", onContext, true);
      });
    }
  };

  const handleEditorChange = useCallback((value: string | undefined) => {
    const next = value ?? "";
    setCurrentBuffer(next);
    onChangeRef.current(next);
  }, []);

  useGitGutter(monacoRef, gutterCollectionRef, workspaceId, filename, currentBuffer);

  // Build the menu items off the live editor instance so we only show
  // actions Monaco actually exposes — clipboard action IDs are documented
  // to be missing in some Monaco builds, so each entry is null-checked
  // before being added (see microsoft/monaco-editor#2598).
  const buildEditorMenuItems = useCallback((): AttachmentContextMenuItem[] => {
    const editor = editorRef.current;
    if (!editor) return [];
    const run = (id: string) => {
      const action = editor.getAction(id);
      if (action) void action.run();
    };
    const has = (id: string) => editor.getAction(id) != null;
    const sel = editor.getSelection();
    const hasSelection = !!sel && !sel.isEmpty();
    const items: AttachmentContextMenuItem[] = [];
    if (has("editor.action.goToDeclaration")) {
      items.push({
        label: "Go to Definition",
        onSelect: () => run("editor.action.goToDeclaration"),
      });
    }
    if (has("editor.action.changeAll")) {
      items.push({
        label: "Change All Occurrences",
        onSelect: () => run("editor.action.changeAll"),
        disabled: readOnly,
      });
    }
    if (has("editor.action.formatDocument")) {
      items.push({
        label: "Format Document",
        onSelect: () => run("editor.action.formatDocument"),
        disabled: readOnly,
      });
    }
    if (has("editor.action.clipboardCutAction")) {
      items.push({
        label: "Cut",
        onSelect: () => run("editor.action.clipboardCutAction"),
        disabled: readOnly || !hasSelection,
      });
    }
    if (has("editor.action.clipboardCopyAction")) {
      items.push({
        label: "Copy",
        onSelect: () => run("editor.action.clipboardCopyAction"),
        disabled: !hasSelection,
      });
    }
    if (has("editor.action.clipboardPasteAction")) {
      items.push({
        label: "Paste",
        onSelect: () => run("editor.action.clipboardPasteAction"),
        disabled: readOnly,
      });
    }
    if (has("editor.action.quickCommand")) {
      items.push({
        label: "Command Palette",
        onSelect: () => run("editor.action.quickCommand"),
      });
    }
    return items;
  }, [readOnly]);

  return (
    <div className={styles.host}>
      <Editor
        height="100%"
        path={filename}
        defaultValue={initialValue}
        theme="claudette"
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={handleEditorChange}
        options={{
          readOnly,
          minimap: { enabled: minimapEnabled },
          wordWrap: "on",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          // Disable the bracket-guides / sticky scroll noise; we want a
          // clean editor surface that matches the surrounding UI density.
          renderWhitespace: "selection",
          stickyScroll: { enabled: false },
          automaticLayout: true,
          // Monaco's built-in context menu ignores html `zoom` and lands
          // offset from the cursor under non-default UI font sizes. We
          // suppress it and render `AttachmentContextMenu` instead, which
          // compensates for engine-specific clientX semantics. See
          // utils/zoom.ts for the engine probe and microsoft/monaco-editor#1203
          // (still open) for upstream's tracking issue.
          contextmenu: false,
          // Literal stack rather than `var(--font-mono)`: Monaco computes
          // character widths via `canvas.measureText`, which does not
          // resolve CSS variables. Mismatched widths cause cursor and
          // selection positioning to drift on every keystroke. The
          // canonical value lives in `src/styles/fonts.ts` and is mirrored
          // into `--font-mono` in `styles/theme.css`; the drift check at
          // `scripts/check-font-mono.mjs` (run by `lint:css`) asserts the
          // two stay equal.
          fontFamily: DEFAULT_MONO_STACK,
          fontSize: 13,
        }}
      />
      {editorMenu ? (
        <AttachmentContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          items={buildEditorMenuItems()}
          onClose={() => setEditorMenu(null)}
        />
      ) : null}
    </div>
  );
});
