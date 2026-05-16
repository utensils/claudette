import type { HotkeyActionId } from "../../../hotkeys/actions";

/** Identifier set used by the menubar. Stable strings so tests can lock them. */
export type EditorMenuId = "file" | "edit" | "view" | "go";

/** A single invokable row in a dropdown. `shortcut` is a pre-resolved
 *  display string (`"⌘S"` / `"Ctrl+S"`) — the config resolves these at
 *  build time so the renderer can stay layout-only. */
export interface EditorMenuItem {
  id: string;
  labelKey: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
}

export type EditorMenuEntry =
  | (EditorMenuItem & { type?: "item" })
  | { type: "separator"; id: string };

export interface EditorMenuDef {
  id: EditorMenuId;
  labelKey: string;
  items: EditorMenuEntry[];
}

/** Handlers — one per menu row. `useEditorActions` builds this from
 *  the active Monaco editor + workspace context; the menubar passes it
 *  straight into `buildEditorMenus`. */
export interface EditorActions {
  onSave: () => void;
  onRevert: () => void;
  onRevealInFiles: () => void;
  onCloseTab: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFind: () => void;
  onReplace: () => void;
  onFormat: () => void;
  onCopyContents: () => void | Promise<void>;
  onCopyPath: () => void | Promise<void>;
  onCopyRelativePath: () => void | Promise<void>;
  onToggleWordWrap: () => void;
  onToggleMinimap: () => void;
  onToggleLineNumbers: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onGoToFile: () => void;
  onGoToLine: () => void;
  onGoToSymbol: () => void;
}

/** Runtime context the menubar reads to label/disable items. The fields
 *  reflect the file currently shown by the viewer, so menu state stays
 *  in step with the editor.
 *
 *  `canEdit` and `editDisabled` are *not* the same: a file might have
 *  been opened read-only (`editDisabled = true`) and still expose Copy /
 *  Find via the menu. `canEdit` is the narrower "Monaco can accept
 *  mutations" gate used for Undo/Redo/Format/Save. */
export interface EditorMenuContext {
  isMac: boolean;
  /** True when the viewer is showing Monaco source (not image/binary/
   *  markdown preview). When false the menubar still renders but most
   *  Edit/View/Go items are disabled. */
  canEdit: boolean;
  /** Active file is dirty (buffer ≠ saved baseline). Drives File > Save
   *  + File > Revert disabled state. */
  dirty: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  minimap: boolean;
  /** Lookup for the display string of a registered Claudette hotkey
   *  (e.g. `global.close-tab` → `"⌘W"`). Returns null when no binding
   *  is set. Use `nativeShortcut` for shortcuts owned by Monaco itself. */
  getHotkeyHint: (actionId: HotkeyActionId) => string | null;
}

/** Platform-specific display label for shortcuts Monaco owns (Find,
 *  Format, Undo, Go to Line, …). Centralized so the test snapshot stays
 *  stable and we don't sprinkle ternaries through the config. */
export function nativeShortcut(
  isMac: boolean,
  mac: string,
  other: string,
): string {
  return isMac ? mac : other;
}

const FILE_MENU_ID: EditorMenuId = "file";
const EDIT_MENU_ID: EditorMenuId = "edit";
const VIEW_MENU_ID: EditorMenuId = "view";
const GO_MENU_ID: EditorMenuId = "go";

/** Assemble the four-menu definition consumed by `EditorMenubar`.
 *
 *  Pure function: no React, no Monaco, no Zustand. Tests call it with
 *  hand-rolled `actions` / `ctx` objects to lock menu structure and
 *  disabled-state rules.
 */
export function buildEditorMenus(
  actions: EditorActions,
  ctx: EditorMenuContext,
): EditorMenuDef[] {
  const ns = (mac: string, other: string) => nativeShortcut(ctx.isMac, mac, other);

  return [
    {
      id: FILE_MENU_ID,
      labelKey: "editor_menu_file",
      items: [
        {
          id: "file.save",
          labelKey: "editor_menu_file_save",
          shortcut: ns("⌘S", "Ctrl+S"),
          disabled: !ctx.canEdit || !ctx.dirty,
          onSelect: actions.onSave,
        },
        {
          id: "file.revert",
          labelKey: "editor_menu_file_revert",
          disabled: !ctx.dirty,
          onSelect: actions.onRevert,
        },
        { type: "separator", id: "file.sep.1" },
        {
          id: "file.reveal-in-files",
          labelKey: "editor_menu_file_reveal_in_files",
          onSelect: actions.onRevealInFiles,
        },
        { type: "separator", id: "file.sep.2" },
        {
          id: "file.close",
          labelKey: "editor_menu_file_close",
          shortcut: ctx.getHotkeyHint("global.close-tab") ?? ns("⌘W", "Ctrl+W"),
          onSelect: actions.onCloseTab,
        },
      ],
    },
    {
      id: EDIT_MENU_ID,
      labelKey: "editor_menu_edit",
      items: [
        {
          id: "edit.undo",
          labelKey: "editor_menu_edit_undo",
          shortcut: ns("⌘Z", "Ctrl+Z"),
          disabled: !ctx.canEdit,
          onSelect: actions.onUndo,
        },
        {
          id: "edit.redo",
          labelKey: "editor_menu_edit_redo",
          shortcut: ns("⇧⌘Z", "Ctrl+Shift+Z"),
          disabled: !ctx.canEdit,
          onSelect: actions.onRedo,
        },
        { type: "separator", id: "edit.sep.1" },
        {
          id: "edit.find",
          labelKey: "editor_menu_edit_find",
          shortcut: ns("⌘F", "Ctrl+F"),
          disabled: !ctx.canEdit,
          onSelect: actions.onFind,
        },
        {
          id: "edit.replace",
          labelKey: "editor_menu_edit_replace",
          shortcut: ns("⌥⌘F", "Ctrl+H"),
          disabled: !ctx.canEdit,
          onSelect: actions.onReplace,
        },
        { type: "separator", id: "edit.sep.2" },
        {
          id: "edit.format",
          labelKey: "editor_menu_edit_format",
          shortcut: ns("⇧⌥F", "Ctrl+Shift+I"),
          disabled: !ctx.canEdit,
          onSelect: actions.onFormat,
        },
        { type: "separator", id: "edit.sep.3" },
        {
          id: "edit.copy-contents",
          labelKey: "editor_menu_edit_copy_contents",
          // The file's bytes can still be useful when read-only (binary
          // metadata copy is the one exception we deliberately skip
          // — `canEdit` is false for images/binary, and copying raw
          // bytes through navigator.clipboard would be nonsense).
          disabled: !ctx.canEdit,
          onSelect: actions.onCopyContents,
        },
        {
          id: "edit.copy-path",
          labelKey: "editor_menu_edit_copy_path",
          onSelect: actions.onCopyPath,
        },
        {
          id: "edit.copy-relative-path",
          labelKey: "editor_menu_edit_copy_relative_path",
          onSelect: actions.onCopyRelativePath,
        },
      ],
    },
    {
      id: VIEW_MENU_ID,
      labelKey: "editor_menu_view",
      items: [
        {
          id: "view.toggle-word-wrap",
          labelKey: ctx.wordWrap
            ? "editor_menu_view_word_wrap_off"
            : "editor_menu_view_word_wrap_on",
          onSelect: actions.onToggleWordWrap,
        },
        {
          id: "view.toggle-minimap",
          labelKey: ctx.minimap
            ? "editor_menu_view_minimap_off"
            : "editor_menu_view_minimap_on",
          onSelect: actions.onToggleMinimap,
        },
        {
          id: "view.toggle-line-numbers",
          labelKey: ctx.lineNumbers
            ? "editor_menu_view_line_numbers_off"
            : "editor_menu_view_line_numbers_on",
          onSelect: actions.onToggleLineNumbers,
        },
        { type: "separator", id: "view.sep.1" },
        {
          id: "view.zoom-in",
          labelKey: "editor_menu_view_zoom_in",
          shortcut: ns("⌘=", "Ctrl+="),
          onSelect: actions.onZoomIn,
        },
        {
          id: "view.zoom-out",
          labelKey: "editor_menu_view_zoom_out",
          shortcut: ns("⌘-", "Ctrl+-"),
          onSelect: actions.onZoomOut,
        },
        {
          id: "view.zoom-reset",
          labelKey: "editor_menu_view_zoom_reset",
          shortcut: ns("⌘0", "Ctrl+0"),
          onSelect: actions.onZoomReset,
        },
      ],
    },
    {
      id: GO_MENU_ID,
      labelKey: "editor_menu_go",
      items: [
        {
          id: "go.go-to-file",
          labelKey: "editor_menu_go_to_file",
          shortcut:
            ctx.getHotkeyHint("global.open-command-palette-file-mode") ??
            ns("⌘P", "Ctrl+P"),
          onSelect: actions.onGoToFile,
        },
        {
          id: "go.go-to-line",
          labelKey: "editor_menu_go_to_line",
          shortcut: ns("⌃G", "Ctrl+G"),
          disabled: !ctx.canEdit,
          onSelect: actions.onGoToLine,
        },
        {
          id: "go.go-to-symbol",
          labelKey: "editor_menu_go_to_symbol",
          shortcut: ns("⇧⌘O", "Ctrl+Shift+O"),
          disabled: !ctx.canEdit,
          onSelect: actions.onGoToSymbol,
        },
      ],
    },
  ];
}
