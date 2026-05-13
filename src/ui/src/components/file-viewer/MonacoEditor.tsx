import { memo, useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import "./monacoSetup";
import { applyMonacoTheme, initMonacoThemeSync } from "./monacoTheme";
import { DEFAULT_MONO_STACK } from "../../styles/fonts";
import { useAppStore } from "../../stores/useAppStore";
import { executeCloseTab, executeNewTab } from "../../hotkeys/contextActions";
import type { FileRevealTarget } from "../../stores/slices/fileTreeSlice";
import {
  useGitGutter,
  type DecorationsCollection,
} from "./useGitGutter";
import styles from "./MonacoEditor.module.css";

interface MonacoEditorProps {
  /** Workspace id used to scope HEAD-blob lookups for the git gutter. */
  workspaceId: string;
  /** Live document text. Driven from the store so external changes
   *  (agent edits, manual saves in another editor, `git checkout`) flow
   *  in via `applyExternalFileChange` and Monaco's controlled-value
   *  path: `@monaco-editor/react` translates each `value` change into
   *  `editor.executeEdits` with full-range replacement + `pushUndoStop`,
   *  preserving the user's cursor position and making the external
   *  change reversible via Cmd+Z.
   *
   *  The parent uses `key={path}` so switching files still remounts the
   *  editor with a fresh undo stack; this prop only flows in-place
   *  updates for the currently-open file. */
  value: string;
  /** File path used to derive the language id. Monaco's built-in detection
   *  works off URI extensions, so we pass the path through as a `path` prop
   *  and let Monaco pick the language. */
  filename: string;
  /** Read-only mode. Toggled at runtime via `updateOptions` so flipping
   *  view/edit doesn't lose cursor position or undo stack. */
  readOnly: boolean;
  /** Optional one-shot reveal target from chat file links. */
  revealTarget?: FileRevealTarget | null;
  onRevealTargetApplied?: (nonce: number) => void;
  /** Fired on every document change. The parent compares against the
   *  baseline to update the per-tab dirty flag. The `@monaco-editor/react`
   *  wrapper internally suppresses this callback while it's applying a
   *  `value`-prop update via `executeEdits`, so external updates do not
   *  bounce back through `onChange` and create an apply loop. */
  onChange: (value: string) => void;
  /** Save callback bound to Cmd/Ctrl+S. The shortcut fires only when the
   *  editor has focus, matching the spec. */
  onSave?: () => void;
}

export const MonacoEditor = memo(function MonacoEditor({
  workspaceId,
  value,
  filename,
  revealTarget,
  onRevealTargetApplied,
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
  const revealCollectionRef = useRef<DecorationsCollection | null>(null);

  // Mirror the editor's text into React state so the git-gutter hook can
  // recompute on every change. Seeded from `value`; user typing updates
  // it via `handleEditorChange`, and external `value`-prop updates sync
  // it via the effect below — the latter keeps the gutter accurate
  // when the file is rewritten on disk while the user isn't typing.
  const [currentBuffer, setCurrentBuffer] = useState(value);
  useEffect(() => {
    setCurrentBuffer(value);
  }, [value]);

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
      revealCollectionRef.current?.clear();
      gutterCollectionRef.current = null;
      revealCollectionRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!editor || !monacoInstance || !revealTarget) return;
    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? revealTarget.startLine;
    const startLine = clampLine(revealTarget.startLine, lineCount);
    const endLine = clampLine(revealTarget.endLine, lineCount);
    const rangeEndLine = Math.max(startLine, endLine);
    const range = new monacoInstance.Range(
      startLine,
      revealTarget.startColumn ?? 1,
      rangeEndLine,
      revealTarget.endColumn ?? model?.getLineMaxColumn(rangeEndLine) ?? 1,
    );
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    revealCollectionRef.current?.set([
      {
        range,
        options: {
          isWholeLine: true,
          className: "claudette-reveal-line",
          overviewRuler: {
            color: "rgba(var(--accent-primary-rgb), 0.65)",
            position: monacoInstance.editor.OverviewRulerLane.Center,
          },
        },
      },
    ]);
    onRevealTargetApplied?.(revealTarget.nonce);
  }, [onRevealTargetApplied, revealTarget]);

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
    revealCollectionRef.current = editor.createDecorationsCollection();
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
    // Override Monaco's defaults for Cmd/Ctrl+T (`gotoSymbolFromKeyboard`)
    // and Cmd/Ctrl+W so the workspace-level new-tab / close-tab actions
    // win when focus is inside the editor. Without these overrides the
    // window-level keydown listener never sees the keystroke — Monaco
    // consumes it inside its own keybinding service and we silently
    // diverge from the rest of the app.
    //
    // We deliberately call into the same `executeNewTab` / `executeCloseTab`
    // helpers used by the global keyboard hook so the routing logic
    // (file → inline-create / chat → archive-with-confirm) lives in
    // exactly one place.
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyT,
      () => executeNewTab(),
    );
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyW,
      () => executeCloseTab(),
    );
  };

  const handleEditorChange = useCallback((value: string | undefined) => {
    const next = value ?? "";
    setCurrentBuffer(next);
    onChangeRef.current(next);
  }, []);

  useGitGutter(monacoRef, gutterCollectionRef, workspaceId, filename, currentBuffer);

  return (
    <div className={styles.host}>
      <Editor
        height="100%"
        path={filename}
        value={value}
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
          scrollbar: {
            verticalScrollbarSize: 8,
            verticalSliderSize: 8,
            horizontalScrollbarSize: 8,
            horizontalSliderSize: 8,
          },
          // Disable the bracket-guides / sticky scroll noise; we want a
          // clean editor surface that matches the surrounding UI density.
          renderWhitespace: "selection",
          stickyScroll: { enabled: false },
          automaticLayout: true,
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
    </div>
  );
});

function clampLine(line: number, lineCount: number): number {
  return Math.max(1, Math.min(line, Math.max(1, lineCount)));
}
