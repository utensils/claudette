export type HotkeyScope = "global" | "terminal" | "file-viewer";
export type KeyMatch = "key" | "code";

export interface PlatformBinding {
  mac?: string | null;
  linux?: string | null;
  windows?: string | null;
}

export interface HotkeyAction {
  id: string;
  scope: HotkeyScope;
  category: string;
  description: string;
  defaultBinding: PlatformBinding;
  match: KeyMatch;
  rebindable: boolean;
  holdMode?: boolean;
  suppressUnderOverlay?: boolean;
  suppressInInteractive?: boolean;
}

const allPlatforms = (binding: string | null): PlatformBinding => ({
  mac: binding,
  linux: binding,
  windows: binding,
});

export const HOTKEY_ACTIONS = [
  {
    id: "global.dismiss-or-stop",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_dismiss_or_stop",
    defaultBinding: allPlatforms("escape"),
    match: "key",
    rebindable: false,
    suppressUnderOverlay: false,
  },
  {
    id: "global.toggle-sidebar",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_sidebar",
    defaultBinding: allPlatforms("mod+b"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.toggle-right-sidebar",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_right_sidebar",
    defaultBinding: allPlatforms("mod+d"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.toggle-fuzzy-finder",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_fuzzy_finder",
    defaultBinding: allPlatforms("mod+k"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: false,
  },
  {
    id: "global.toggle-command-palette",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_command_palette",
    defaultBinding: allPlatforms("mod+p"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: false,
  },
  {
    id: "global.open-command-palette-file-mode",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_open_command_palette_file_mode",
    defaultBinding: allPlatforms("mod+o"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.toggle-terminal-panel",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_terminal_panel",
    defaultBinding: allPlatforms("mod+`"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.focus-toggle",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_focus_toggle",
    defaultBinding: allPlatforms("mod+0"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.open-settings",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_open_settings",
    defaultBinding: allPlatforms("mod+,"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: false,
  },
  {
    id: "global.open-chat-search",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_open_chat_search",
    defaultBinding: allPlatforms("mod+code:KeyF"),
    match: "code",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    // Cycles the unified workspace tab strip (chat sessions, diff tabs,
    // file tabs) one slot left/right with wrap-around. Earlier this binding
    // navigated across workspaces (`global.cycle-workspace-prev/next`), but
    // the unified tab strip subsumed enough per-workspace surfaces that
    // tab-cycle became the higher-frequency intent. Workspace navigation
    // now lives in the sidebar, the fuzzy finder, and the existing
    // `global.jump-to-project-1..9` hotkeys.
    id: "global.cycle-tab-prev",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_cycle_tab_prev",
    defaultBinding: allPlatforms("mod+shift+code:BracketLeft"),
    match: "code",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "global.cycle-tab-next",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_cycle_tab_next",
    defaultBinding: allPlatforms("mod+shift+code:BracketRight"),
    match: "code",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  ...Array.from({ length: 9 }, (_, i): HotkeyAction => ({
    id: `global.jump-to-project-${i + 1}`,
    scope: "global",
    category: "keyboard_category_navigation",
    description: `keyboard_action_jump_to_project_${i + 1}`,
    defaultBinding: allPlatforms(`mod+${i + 1}`),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  })),
  {
    id: "global.increase-ui-font",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_increase_ui_font",
    defaultBinding: allPlatforms("mod+code:Equal"),
    match: "code",
    rebindable: true,
    suppressUnderOverlay: false,
  },
  {
    id: "global.decrease-ui-font",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_decrease_ui_font",
    defaultBinding: allPlatforms("mod+code:Minus"),
    match: "code",
    rebindable: true,
    suppressUnderOverlay: false,
  },
  {
    // Cmd/Ctrl+T: context-aware "new tab".
    //  - When the workspace's right pane is showing a file (an
    //    `activeFileTabByWorkspace` entry exists), this triggers the
    //    inline "create new file" flow at the workspace root in the
    //    Files panel — matches editor muscle memory for "new tab".
    //  - Otherwise (chat or diff is showing), it creates a new chat
    //    session in the current workspace.
    //
    // `terminal.new-tab` is independently scoped to `terminal` and still
    // owns mod+t when the user is typing inside a terminal pane, so this
    // doesn't fight terminal tab creation. Previously Cmd+T was wired
    // through a raw `window.addEventListener("keydown")` in
    // `ChatToolbar`/`ComposerToolbar` to toggle thinking mode; that
    // bypass-the-keybinding-system shortcut is removed in favor of this
    // registered action so users can rebind it from Keyboard Settings.
    id: "global.new-tab",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_new_tab",
    defaultBinding: allPlatforms("mod+t"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
    suppressInInteractive: false,
  },
  {
    id: "global.toggle-plan-mode",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_toggle_plan_mode",
    defaultBinding: allPlatforms("shift+tab"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
    suppressInInteractive: true,
  },
  {
    id: "terminal.new-tab",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_new_tab",
    defaultBinding: { mac: "mod+t", linux: "mod+shift+t", windows: "mod+shift+t" },
    match: "key",
    rebindable: true,
  },
  {
    id: "terminal.cycle-tab-prev",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_cycle_tab_prev",
    defaultBinding: allPlatforms("mod+shift+code:BracketLeft"),
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.cycle-tab-next",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_cycle_tab_next",
    defaultBinding: allPlatforms("mod+shift+code:BracketRight"),
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.toggle-panel",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_toggle_terminal_panel",
    defaultBinding: allPlatforms("mod+`"),
    match: "key",
    rebindable: true,
  },
  {
    id: "terminal.focus-chat",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_focus_chat",
    defaultBinding: allPlatforms("mod+0"),
    match: "key",
    rebindable: true,
  },
  {
    id: "terminal.zoom-in",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_increase_ui_font",
    defaultBinding: allPlatforms("mod+code:Equal"),
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.zoom-out",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_decrease_ui_font",
    defaultBinding: allPlatforms("mod+code:Minus"),
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.split-pane-horizontal",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_split_horizontal",
    defaultBinding: { mac: "mod+code:KeyD", linux: "mod+shift+code:KeyD", windows: "mod+shift+code:KeyD" },
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.split-pane-vertical",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_split_vertical",
    defaultBinding: { mac: "mod+shift+code:KeyD", linux: "mod+shift+alt+code:KeyD", windows: "mod+shift+alt+code:KeyD" },
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.close-pane",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_close_pane",
    defaultBinding: { mac: "mod+w", linux: "mod+shift+w", windows: "mod+shift+w" },
    match: "key",
    rebindable: true,
  },
  ...(["left", "right", "up", "down"] as const).map((direction): HotkeyAction => ({
    id: `terminal.focus-pane-${direction}`,
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: `keyboard_action_terminal_focus_pane_${direction}`,
    defaultBinding: allPlatforms(`alt+code:Arrow${direction[0].toUpperCase()}${direction.slice(1)}`),
    match: "code",
    rebindable: true,
  })),
  {
    id: "terminal.copy-selection",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_copy_selection",
    defaultBinding: { mac: "mod+code:KeyC", linux: "mod+shift+code:KeyC", windows: "mod+shift+code:KeyC" },
    match: "code",
    rebindable: true,
  },
  {
    id: "terminal.paste",
    scope: "terminal",
    category: "keyboard_category_terminal",
    description: "keyboard_action_terminal_paste",
    defaultBinding: { mac: "mod+code:KeyV", linux: "mod+shift+code:KeyV", windows: "mod+shift+code:KeyV" },
    match: "code",
    rebindable: true,
  },
  {
    // Cmd/Ctrl+W: context-aware "close tab".
    //  - File active in the right pane → routes through the FileViewer's
    //    dirty-aware close path (preserves the existing discard-changes
    //    confirmation modal).
    //  - Diff active → closes the diff tab.
    //  - Chat active → archives the active chat session, gated by the
    //    shared confirm rules in `chatCloseConfirmMessage` (running
    //    sessions, the active session, and the last remaining session
    //    all prompt before close).
    //
    // Replaces the prior `file-viewer.close-file-tab` action; the
    // `20260509000540_rename_close_file_tab_keybinding.sql` migration
    // carries any user-customised binding forward.
    id: "global.close-tab",
    scope: "global",
    category: "keyboard_category_navigation",
    description: "keyboard_action_close_tab",
    defaultBinding: allPlatforms("mod+w"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "file-viewer.undo-file-operation",
    scope: "file-viewer",
    category: "keyboard_category_editor",
    description: "keyboard_action_file_undo_operation",
    defaultBinding: allPlatforms("mod+z"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "file-viewer.toggle-markdown-preview",
    scope: "file-viewer",
    category: "keyboard_category_editor",
    description: "keyboard_action_file_toggle_markdown_preview",
    defaultBinding: allPlatforms("mod+shift+v"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    // Skip the queue: while the agent is running, send the typed message
    // immediately as a steer (mid-turn injection) instead of queuing it
    // for after the current turn finishes. Defaults to Cmd/Ctrl+Enter so
    // a regular Enter still queues — matches the muscle-memory of "send
    // now" in editors and ChatGPT's web UI.
    id: "chat.steer-immediate",
    scope: "global",
    category: "keyboard_category_chat",
    description: "keyboard_action_chat_steer_immediate",
    defaultBinding: allPlatforms("mod+enter"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "voice.toggle",
    scope: "global",
    category: "keyboard_category_voice",
    description: "keyboard_action_voice_toggle",
    defaultBinding: allPlatforms("mod+shift+m"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: true,
  },
  {
    id: "voice.hold",
    scope: "global",
    category: "keyboard_category_voice",
    description: "keyboard_action_voice_hold",
    defaultBinding: { mac: "code:AltRight", linux: null, windows: null },
    match: "code",
    rebindable: true,
    holdMode: true,
    suppressUnderOverlay: true,
  },
  {
    // Default `mod+/` matches `Cmd+/` on macOS and `Ctrl+/` elsewhere.
    // The binding is the literal "/" — `parseBinding` splits on "+" and
    // takes the trailing piece, and `normalizeKey("/")` returns "/" (no
    // alias to "slash"). The macOS Help-menu accelerator in
    // src-tauri/src/main.rs uses Tauri's separate accelerator format
    // (`CmdOrCtrl+Slash`), and bindings.test.ts locks the two together.
    id: "global.show-keyboard-shortcuts",
    scope: "global",
    category: "keyboard_category_help",
    description: "keyboard_action_show_shortcuts",
    defaultBinding: allPlatforms("mod+/"),
    match: "key",
    rebindable: true,
    suppressUnderOverlay: false,
  },
] as const satisfies readonly HotkeyAction[];

export type HotkeyActionId = (typeof HOTKEY_ACTIONS)[number]["id"];

export function findHotkeyAction(id: string): HotkeyAction | undefined {
  return HOTKEY_ACTIONS.find((action) => action.id === id);
}
