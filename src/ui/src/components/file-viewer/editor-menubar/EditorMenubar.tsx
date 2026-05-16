import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { editor as MonacoNs } from "monaco-editor";
import { useAppStore } from "../../../stores/useAppStore";
import { isMacHotkeyPlatform } from "../../../hotkeys/platform";
import { getHotkeyLabel } from "../../../hotkeys/display";
import type { HotkeyActionId } from "../../../hotkeys/actions";
import { ContextMenu, type ContextMenuItem } from "../../shared/ContextMenu";
import {
  buildEditorMenus,
  type EditorMenuDef,
  type EditorMenuEntry,
  type EditorMenuId,
} from "./editorMenuConfig";
import { useEditorActions } from "./useEditorActions";
import styles from "./EditorMenubar.module.css";

interface EditorMenubarProps {
  workspaceId: string;
  path: string;
  /** True when the buffer is dirty (drives Save / Revert enabled state). */
  dirty: boolean;
  /** True when Monaco is mounted with a live model (so read-only
   *  actions like Find, Go to Line, Copy File Contents have something
   *  to operate on). False when the viewer is showing an image /
   *  binary / markdown preview. */
  hasEditor: boolean;
  /** True only when Monaco can accept edits — gates Save, Undo, Redo,
   *  Replace, Format. Always implies `hasEditor`. */
  canMutate: boolean;
  editorRef: MutableRefObject<MonacoNs.IStandaloneCodeEditor | null>;
  /** FileViewer's existing save handler — already routes through the
   *  dirty-aware toast + diff refresh pipeline. */
  onSave: () => void;
  /** FileViewer's existing close handler — already routes through the
   *  discard-unsaved-changes modal. */
  onCloseTab: () => void;
}

/** Translator shape the menubar needs — a single-arg `t(key)` lookup.
 *  We avoid the full `TFunction<"chat">` generic so this helper stays
 *  callable from tests that don't bother typing their stub translator. */
type MenubarTranslator = (key: string) => string;

/** Convert a config entry into the shape ContextMenu wants. Reused by
 *  the test surface — exported separately so unit tests can lock the
 *  conversion logic without spinning up React. */
export function toContextMenuItem(
  entry: EditorMenuEntry,
  t: MenubarTranslator,
): ContextMenuItem {
  if ("type" in entry && entry.type === "separator") {
    return { type: "separator" };
  }
  return {
    label: t(entry.labelKey),
    onSelect: entry.onSelect,
    shortcut: entry.shortcut,
    disabled: entry.disabled,
  };
}

export function EditorMenubar(props: EditorMenubarProps) {
  const {
    workspaceId,
    path,
    dirty,
    hasEditor,
    canMutate,
    editorRef,
    onSave,
    onCloseTab,
  } = props;
  const { t } = useTranslation("chat");
  // Menu labels are looked up from `labelKey` strings stored in the
  // pure config — runtime values, not literal types. The `as never`
  // cast tells the strongly-typed i18next overload to accept the lookup;
  // the same shim is used by `KeyboardSettings` and
  // `KeyboardShortcutsModal` for the same reason.
  const tx = useCallback((key: string): string => t(key as never), [t]);

  const [openMenuId, setOpenMenuId] = useState<EditorMenuId | null>(null);
  const triggerRefs = useRef<Record<EditorMenuId, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    view: null,
    go: null,
  });

  const keybindings = useAppStore((s) => s.keybindings);
  const wordWrap = useAppStore((s) => s.editorWordWrap);
  const lineNumbers = useAppStore((s) => s.editorLineNumbersEnabled);
  const minimap = useAppStore((s) => s.editorMinimapEnabled);
  const isMac = isMacHotkeyPlatform();

  const actions = useEditorActions({
    workspaceId,
    path,
    editorRef,
    onSave,
    onCloseTab,
  });

  const menus = useMemo<EditorMenuDef[]>(
    () =>
      buildEditorMenus(actions, {
        isMac,
        hasEditor,
        canMutate,
        dirty,
        wordWrap,
        lineNumbers,
        minimap,
        getHotkeyHint: (id: HotkeyActionId) =>
          getHotkeyLabel(id, keybindings, isMac),
      }),
    [
      actions,
      canMutate,
      dirty,
      hasEditor,
      isMac,
      keybindings,
      lineNumbers,
      minimap,
      wordWrap,
    ],
  );

  const activeMenu = useMemo(
    () => (openMenuId ? menus.find((m) => m.id === openMenuId) ?? null : null),
    [menus, openMenuId],
  );

  const closeMenu = useCallback(() => setOpenMenuId(null), []);

  const handleClick = useCallback((id: EditorMenuId) => {
    setOpenMenuId((cur) => (cur === id ? null : id));
  }, []);

  const handleHover = useCallback((id: EditorMenuId) => {
    setOpenMenuId((cur) => (cur !== null && cur !== id ? id : cur));
  }, []);

  const items: ContextMenuItem[] = useMemo(() => {
    if (!activeMenu) return [];
    return activeMenu.items.map((entry) => toContextMenuItem(entry, tx));
  }, [activeMenu, tx]);

  const anchor = useMemo(() => {
    if (!activeMenu) return null;
    const node = triggerRefs.current[activeMenu.id];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    // 2px gap between the trigger and the dropdown — small enough that
    // pointer travel feels continuous, big enough to read the menubar
    // separator beneath it.
    return { x: rect.left, y: rect.bottom + 2 };
  }, [activeMenu]);

  return (
    <div className={styles.menubar} role="menubar" data-testid="editor-menubar">
      {menus.map((menu) => (
        <button
          key={menu.id}
          type="button"
          ref={(el) => {
            triggerRefs.current[menu.id] = el;
          }}
          className={`${styles.trigger} ${
            openMenuId === menu.id ? styles.triggerActive : ""
          }`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openMenuId === menu.id}
          data-menu-id={menu.id}
          onClick={() => handleClick(menu.id)}
          onMouseEnter={() => handleHover(menu.id)}
        >
          {tx(menu.labelKey)}
        </button>
      ))}
      {activeMenu && anchor && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={items}
          onClose={closeMenu}
          dataTestId={`editor-menu-dropdown-${activeMenu.id}`}
        />
      )}
    </div>
  );
}
