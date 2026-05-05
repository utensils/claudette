import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "../../styles/themes";
import type { AppState } from "../useAppStore";

export interface SettingsSlice {
  worktreeBaseDir: string;
  setWorktreeBaseDir: (dir: string) => void;
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

  // Experimental
  usageInsightsEnabled: boolean;
  setUsageInsightsEnabled: (enabled: boolean) => void;
  pluginManagementEnabled: boolean;
  setPluginManagementEnabled: (enabled: boolean) => void;
  /// Gate the Settings → Community section. When false, the section is
  /// hidden from the sidebar and direct navigation falls back to
  /// Experimental. The backend community_* commands ship unconditionally
  /// — flipping this flag exposes them to the user.
  communityRegistryEnabled: boolean;
  setCommunityRegistryEnabled: (enabled: boolean) => void;
  disable1mContext: boolean;
  setDisable1mContext: (v: boolean) => void;
  /// Which revision the Monaco git gutter compares the editor buffer
  /// against. "head" (default) shows uncommitted changes only; "merge_base"
  /// shows every change made on the workspace's branch since it diverged
  /// from the repo's base branch (matches the Changes panel).
  editorGitGutterBase: "head" | "merge_base";
  setEditorGitGutterBase: (value: "head" | "merge_base") => void;
}

export const createSettingsSlice: StateCreator<
  AppState,
  [],
  [],
  SettingsSlice
> = (set) => ({
  worktreeBaseDir: "",
  setWorktreeBaseDir: (dir) => set({ worktreeBaseDir: dir }),
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
  editorGitGutterBase: "head",
  setEditorGitGutterBase: (value) => set({ editorGitGutterBase: value }),
});
