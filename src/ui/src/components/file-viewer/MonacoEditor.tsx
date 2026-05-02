import { memo, useEffect, useRef } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import "./monacoSetup";
import { applyMonacoTheme, initMonacoThemeSync } from "./monacoTheme";
import styles from "./MonacoEditor.module.css";

interface MonacoEditorProps {
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
  const cleanupThemeSyncRef = useRef<(() => void) | null>(null);

  // Reflect readOnly changes into the editor without remounting. Monaco's
  // `updateOptions` is the explicit runtime API for this; with CodeMirror
  // we had to recreate EditorState, but here it's a one-liner.
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  // Disconnect the theme observer when the editor unmounts.
  useEffect(() => () => { cleanupThemeSyncRef.current?.(); }, []);

  // Define the 'claudette' theme before the editor instance is created so
  // the theme prop resolves immediately and there's no flash of vs-dark.
  const handleBeforeMount: BeforeMount = (monacoInstance) => {
    applyMonacoTheme(monacoInstance);
  };

  const handleMount: OnMount = (editor, monacoInstance) => {
    editorRef.current = editor;
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

  return (
    <div className={styles.host}>
      <Editor
        height="100%"
        path={filename}
        defaultValue={initialValue}
        theme="claudette"
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        onChange={(value) => onChangeRef.current(value ?? "")}
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
          // selection positioning to drift on every keystroke. Mirrors
          // the value of `--font-mono` in styles/theme.css.
          fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", monospace',
          fontSize: 13,
        }}
      />
    </div>
  );
});
