import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "../../styles/themes";
import type { ClaudeFlagDef } from "../../services/claudeFlags";
import type { AppState } from "../useAppStore";
import type { AgentBackendConfig } from "../../services/tauri";

export type ToolDisplayMode = "grouped" | "inline";

export interface SettingsSlice {
  worktreeBaseDir: string;
  setWorktreeBaseDir: (dir: string) => void;
  defaultTerminalAppId: string | null;
  setDefaultTerminalAppId: (appId: string | null) => void;
  /// Ordered list of app IDs surfaced at the top level of the workspace
  /// "Open in app" menu. `null` (the default) means "show all detected apps"
  /// — the existing behavior. Once curated, anything not in this list is
  /// reachable under the menu's "More" flyout. Persisted as the
  /// `workspace_apps_menu` app setting (`{ "shown": [...] }`).
  workspaceAppsMenuShown: string[] | null;
  setWorkspaceAppsMenuShown: (ids: string[] | null) => void;
  defaultBranches: Record<string, string>;
  setDefaultBranches: (branches: Record<string, string>) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  uiFontSize: number;
  setUiFontSize: (size: number) => void;
  fontFamilySans: string;
  setFontFamilySans: (font: string) => void;
  fontFamilyMono: string;
  setFontFamilyMono: (font: string) => void;
  systemFonts: string[];
  setSystemFonts: (fonts: string[]) => void;
  currentThemeId: string;
  setCurrentThemeId: (id: string) => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (mode: "light" | "dark" | "system") => void;
  themeDark: string;
  setThemeDark: (id: string) => void;
  themeLight: string;
  setThemeLight: (id: string) => void;

  // Sidebar display preferences
  /// Show running terminal commands under each workspace in the sidebar.
  /// Off by default — opt in via Settings → Appearance.
  showSidebarRunningCommands: boolean;
  setShowSidebarRunningCommands: (v: boolean) => void;
  toolDisplayMode: ToolDisplayMode;
  setToolDisplayMode: (mode: ToolDisplayMode) => void;
  extendedToolCallOutput: boolean;
  setExtendedToolCallOutput: (enabled: boolean) => void;

  // Experimental
  claudetteTerminalEnabled: boolean;
  setClaudetteTerminalEnabled: (enabled: boolean) => void;
  usageInsightsEnabled: boolean;
  setUsageInsightsEnabled: (enabled: boolean) => void;
  pluginManagementEnabled: boolean;
  setPluginManagementEnabled: (enabled: boolean) => void;
  claudeRemoteControlEnabled: boolean;
  setClaudeRemoteControlEnabled: (enabled: boolean) => void;
  /// Gate the Settings → Community section. When false, the section is
  /// hidden from the sidebar and direct navigation falls back to
  /// Experimental. The backend community_* commands ship unconditionally
  /// — flipping this flag exposes them to the user.
  communityRegistryEnabled: boolean;
  setCommunityRegistryEnabled: (enabled: boolean) => void;
  disable1mContext: boolean;
  setDisable1mContext: (v: boolean) => void;
  alternativeBackendsAvailable: boolean;
  setAlternativeBackendsAvailable: (available: boolean) => void;
  alternativeBackendsEnabled: boolean;
  setAlternativeBackendsEnabled: (enabled: boolean) => void;
  codexEnabled: boolean;
  setCodexEnabled: (enabled: boolean) => void;
  agentBackends: AgentBackendConfig[];
  setAgentBackends: (backends: AgentBackendConfig[]) => void;
  defaultAgentBackendId: string;
  setDefaultAgentBackendId: (id: string) => void;
  /// Which revision the Monaco git gutter compares the editor buffer
  /// against. "head" (default) shows uncommitted changes only; "merge_base"
  /// shows every change made on the workspace's branch since it diverged
  /// from the repo's base branch (matches the Changes panel).
  editorGitGutterBase: "head" | "merge_base";
  setEditorGitGutterBase: (value: "head" | "merge_base") => void;
  editorMinimapEnabled: boolean;
  setEditorMinimapEnabled: (enabled: boolean) => void;
  keybindings: Record<string, string | null>;
  setKeybinding: (actionId: string, binding: string | null) => void;
  resetKeybinding: (actionId: string) => void;
  setKeybindings: (bindings: Record<string, string | null>) => void;
  voiceToggleHotkey: string | null;
  setVoiceToggleHotkey: (hotkey: string | null) => void;
  voiceHoldHotkey: string | null;
  setVoiceHoldHotkey: (hotkey: string | null) => void;

  /// Cached parse of `claude --help`. `null` until the section first loads
  /// (or the discovery task hasn't finished yet). Per-scope persisted values
  /// are fetched per-mount and live in the section component, not here.
  claudeFlagDefs: ClaudeFlagDef[] | null;
  setClaudeFlagDefs: (defs: ClaudeFlagDef[] | null) => void;
}

export const createSettingsSlice: StateCreator<
  AppState,
  [],
  [],
  SettingsSlice
> = (set) => ({
  worktreeBaseDir: "",
  setWorktreeBaseDir: (dir) => set({ worktreeBaseDir: dir }),
  defaultTerminalAppId: null,
  setDefaultTerminalAppId: (appId) => set({ defaultTerminalAppId: appId }),
  workspaceAppsMenuShown: null,
  setWorkspaceAppsMenuShown: (ids) => set({ workspaceAppsMenuShown: ids }),
  defaultBranches: {},
  setDefaultBranches: (branches) => set({ defaultBranches: branches }),
  terminalFontSize: 11,
  setTerminalFontSize: (size) => set({ terminalFontSize: size }),
  uiFontSize: 13,
  setUiFontSize: (size) => set({ uiFontSize: size }),
  fontFamilySans: "",
  setFontFamilySans: (font) => set({ fontFamilySans: font }),
  fontFamilyMono: "",
  setFontFamilyMono: (font) => set({ fontFamilyMono: font }),
  systemFonts: [],
  setSystemFonts: (fonts) => set({ systemFonts: fonts }),
  currentThemeId: DEFAULT_THEME_ID,
  setCurrentThemeId: (id) => set({ currentThemeId: id }),
  themeMode: "dark",
  setThemeMode: (mode) => set({ themeMode: mode }),
  themeDark: DEFAULT_THEME_ID,
  setThemeDark: (id) => set({ themeDark: id }),
  themeLight: DEFAULT_LIGHT_THEME_ID,
  setThemeLight: (id) => set({ themeLight: id }),

  showSidebarRunningCommands: false,
  setShowSidebarRunningCommands: (v) => set({ showSidebarRunningCommands: v }),
  toolDisplayMode: "grouped",
  setToolDisplayMode: (mode) => set({ toolDisplayMode: mode }),
  extendedToolCallOutput: false,
  setExtendedToolCallOutput: (enabled) =>
    set({ extendedToolCallOutput: enabled }),

  claudetteTerminalEnabled: false,
  setClaudetteTerminalEnabled: (enabled) =>
    set({ claudetteTerminalEnabled: enabled }),
  usageInsightsEnabled: false,
  setUsageInsightsEnabled: (enabled) => set({ usageInsightsEnabled: enabled }),
  pluginManagementEnabled: false,
  setPluginManagementEnabled: (enabled) =>
    set((state) => ({
      pluginManagementEnabled: enabled,
      settingsSection:
        !enabled && state.settingsSection === "claude-code-plugins"
          ? "experimental"
          : state.settingsSection,
      pluginSettingsIntent: enabled ? state.pluginSettingsIntent : null,
      pluginSettingsRepoId: enabled ? state.pluginSettingsRepoId : null,
      pluginSettingsTab: enabled ? state.pluginSettingsTab : "available",
    })),
  claudeRemoteControlEnabled: true,
  setClaudeRemoteControlEnabled: (enabled) =>
    set({ claudeRemoteControlEnabled: enabled }),
  communityRegistryEnabled: false,
  setCommunityRegistryEnabled: (enabled) =>
    set((state) => ({
      communityRegistryEnabled: enabled,
      // Bounce out of the Community section if the user disables the
      // flag while it's open. Same shape as the claude-code-plugins
      // bounce above.
      settingsSection:
        !enabled && state.settingsSection === "community"
          ? "experimental"
          : state.settingsSection,
    })),
  disable1mContext: false,
  setDisable1mContext: (v) => set({ disable1mContext: v }),
  alternativeBackendsAvailable: false,
  setAlternativeBackendsAvailable: (available) =>
    set((state) => ({
      alternativeBackendsAvailable: available,
      alternativeBackendsEnabled: available ? state.alternativeBackendsEnabled : false,
      codexEnabled: available ? state.codexEnabled : false,
    })),
  alternativeBackendsEnabled: false,
  setAlternativeBackendsEnabled: (enabled) =>
    set((state) => ({
      alternativeBackendsEnabled: state.alternativeBackendsAvailable && enabled,
    })),
  codexEnabled: false,
  setCodexEnabled: (enabled) =>
    set((state) => ({
      codexEnabled: state.alternativeBackendsAvailable && enabled,
    })),
  agentBackends: [],
  setAgentBackends: (backends) => set({ agentBackends: backends }),
  defaultAgentBackendId: "anthropic",
  setDefaultAgentBackendId: (id) => set({ defaultAgentBackendId: id }),
  editorGitGutterBase: "head",
  setEditorGitGutterBase: (value) => set({ editorGitGutterBase: value }),
  editorMinimapEnabled: false,
  setEditorMinimapEnabled: (enabled) => set({ editorMinimapEnabled: enabled }),
  keybindings: {},
  setKeybinding: (actionId, binding) =>
    set((state) => ({ keybindings: { ...state.keybindings, [actionId]: binding } })),
  resetKeybinding: (actionId) =>
    set((state) => {
      const next = { ...state.keybindings };
      delete next[actionId];
      return { keybindings: next };
    }),
  setKeybindings: (bindings) => set({ keybindings: bindings }),
  voiceToggleHotkey: null,
  setVoiceToggleHotkey: (hotkey) => set({ voiceToggleHotkey: hotkey }),
  voiceHoldHotkey: null,
  setVoiceHoldHotkey: (hotkey) => set({ voiceHoldHotkey: hotkey }),

  claudeFlagDefs: null,
  setClaudeFlagDefs: (defs) => set({ claudeFlagDefs: defs }),
});
