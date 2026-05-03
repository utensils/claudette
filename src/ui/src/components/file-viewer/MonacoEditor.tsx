import { memo, useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import "./monacoSetup";
import { applyMonacoTheme, initMonacoThemeSync } from "./monacoTheme";
import { DEFAULT_MONO_STACK } from "../../styles/fonts";
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

  // Reflect readOnly changes into the editor without remounting. Monaco's
  // `updateOptions` is the explicit runtime API for this; with CodeMirror
  // we had to recreate EditorState, but here it's a one-liner.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

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
        defaultValue={initialValue}
        theme="claudette"
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={handleEditorChange}
        options={{
          readOnly,
          minimap: { enabled: false },
          wordWrap: "on",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
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
