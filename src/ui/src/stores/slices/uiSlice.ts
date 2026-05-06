import type { StateCreator } from "zustand";
import type { AttachmentInput } from "../../types";
import type {
  PluginSettingsIntent,
  PluginSettingsTab,
} from "../../types/plugins";
import type { AppState } from "../useAppStore";

export interface UiSlice {
  metaKeyHeld: boolean;
  setMetaKeyHeld: (held: boolean) => void;
  sidebarVisible: boolean;
  rightSidebarVisible: boolean;
  sidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  rightSidebarTab: "files" | "changes" | "tasks";
  sidebarGroupBy: "status" | "repo";
  sidebarRepoFilter: string; // repo ID or "all"
  sidebarShowArchived: boolean;
  manualWorkspaceOrderByRepo: Record<string, "manual">;
  repoCollapsed: Record<string, boolean>;
  statusGroupCollapsed: Record<string, boolean>;
  fuzzyFinderOpen: boolean;
  commandPaletteOpen: boolean;
  commandPaletteInitialMode: "file" | null;
  toggleSidebar: () => void;
  toggleRightSidebar: () => void;
  setRightSidebarTab: (tab: "files" | "changes" | "tasks") => void;
  setSidebarWidth: (w: number) => void;
  setRightSidebarWidth: (w: number) => void;
  setTerminalHeight: (h: number) => void;
  setSidebarGroupBy: (g: "status" | "repo") => void;
  setSidebarRepoFilter: (id: string) => void;
  setSidebarShowArchived: (show: boolean) => void;
  setManualWorkspaceOrderByRepo: (
    modes: Record<string, "manual">,
  ) => void;
  markWorkspaceOrderManual: (repoId: string) => void;
  clearManualWorkspaceOrder: (repoId: string) => void;
  toggleRepoCollapsed: (id: string) => void;
  toggleStatusGroupCollapsed: (id: string) => void;
  toggleFuzzyFinder: () => void;
  toggleCommandPalette: () => void;
  openCommandPaletteFileMode: () => void;
  clearCommandPaletteInitialMode: () => void;

  // Settings page
  settingsOpen: boolean;
  settingsSection: string | null;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  pluginSettingsTab: PluginSettingsTab;
  pluginSettingsRepoId: string | null;
  pluginSettingsIntent: PluginSettingsIntent | null;
  pluginRefreshToken: number;
  openPluginSettings: (intent?: Partial<PluginSettingsIntent>) => void;
  setPluginSettingsTab: (tab: PluginSettingsTab) => void;
  setPluginSettingsRepoId: (repoId: string | null) => void;
  clearPluginSettingsIntent: () => void;
  bumpPluginRefreshToken: () => void;
  /** Voice provider whose details panel should be expanded on next render
   *  of PluginsSettings. Set when the user clicks the mic button and is
   *  redirected to settings to grant permissions / install models, so the
   *  user lands directly on the action they need to take. Cleared once the
   *  panel has consumed the focus. */
  voiceProviderFocus: string | null;
  focusVoiceProvider: (providerId: string | null) => void;

  // Modals
  activeModal: string | null;
  modalData: Record<string, unknown>;
  openModal: (name: string, data?: Record<string, unknown>) => void;
  closeModal: () => void;

  // Chat input prefill (e.g. after rollback)
  chatInputPrefill: string | null;
  setChatInputPrefill: (text: string | null) => void;
  pendingAttachmentsPrefill: AttachmentInput[] | null;
  setPendingAttachmentsPrefill: (atts: AttachmentInput[] | null) => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (
  set,
) => ({
  metaKeyHeld: false,
  setMetaKeyHeld: (held) => set({ metaKeyHeld: held }),
  sidebarVisible: true,
  rightSidebarVisible: false,
  sidebarWidth: 260,
  rightSidebarWidth: 250,
  terminalHeight: 300,
  rightSidebarTab: "files",
  sidebarGroupBy: "repo",
  sidebarRepoFilter: "all",
  sidebarShowArchived: false,
  manualWorkspaceOrderByRepo: {},
  repoCollapsed: {},
  statusGroupCollapsed: {},
  fuzzyFinderOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleRightSidebar: () =>
    set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setRightSidebarWidth: (w) => set({ rightSidebarWidth: w }),
  setTerminalHeight: (h) => set({ terminalHeight: h }),
  setSidebarGroupBy: (g) => set({ sidebarGroupBy: g }),
  setSidebarRepoFilter: (id) => set({ sidebarRepoFilter: id }),
  setSidebarShowArchived: (show) => set({ sidebarShowArchived: show }),
  setManualWorkspaceOrderByRepo: (modes) =>
    set({ manualWorkspaceOrderByRepo: modes }),
  markWorkspaceOrderManual: (repoId) =>
    set((s) => ({
      manualWorkspaceOrderByRepo: {
        ...s.manualWorkspaceOrderByRepo,
        [repoId]: "manual",
      },
    })),
  clearManualWorkspaceOrder: (repoId) =>
    set((s) => {
      if (!(repoId in s.manualWorkspaceOrderByRepo)) return s;
      const next = { ...s.manualWorkspaceOrderByRepo };
      delete next[repoId];
      return { manualWorkspaceOrderByRepo: next };
    }),
  toggleRepoCollapsed: (id) =>
    set((s) => ({
      repoCollapsed: {
        ...s.repoCollapsed,
        [id]: !s.repoCollapsed[id],
      },
    })),
  toggleStatusGroupCollapsed: (id) =>
    set((s) => ({
      statusGroupCollapsed: {
        ...s.statusGroupCollapsed,
        [id]: !s.statusGroupCollapsed[id],
      },
    })),
  toggleFuzzyFinder: () =>
    set((s) => ({ fuzzyFinderOpen: !s.fuzzyFinderOpen })),
  commandPaletteOpen: false,
  commandPaletteInitialMode: null,
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  openCommandPaletteFileMode: () =>
    set({ commandPaletteOpen: true, commandPaletteInitialMode: "file" }),
  clearCommandPaletteInitialMode: () =>
    set({ commandPaletteInitialMode: null }),

  // Settings page
  settingsOpen: false,
  settingsSection: null,
  openSettings: (section = "general") =>
    set((state) => {
      const nextSection = section === "plugins" && !state.pluginManagementEnabled
        ? "experimental"
        : section;
      return {
        settingsOpen: true,
        settingsSection: nextSection,
        pluginSettingsIntent: nextSection === "plugins" ? null : state.pluginSettingsIntent,
        pluginSettingsRepoId: nextSection === "plugins" ? null : state.pluginSettingsRepoId,
        pluginSettingsTab: nextSection === "plugins" ? "available" : state.pluginSettingsTab,
      };
    }),
  closeSettings: () =>
    set({
      settingsOpen: false,
      settingsSection: null,
      pluginSettingsIntent: null,
      pluginSettingsRepoId: null,
    }),
  setSettingsSection: (section) =>
    set((state) => {
      // Claude Code Plugins requires plugin management to be on; when
      // disabled, fall through to the experimental pane so the setting
      // stays reachable. The new "plugins" section (Claudette's own
      // Lua plugins) is always available.
      const nextSection =
        section === "claude-code-plugins" && !state.pluginManagementEnabled
          ? "experimental"
          : section;
      const resetMarketplaceIntent = nextSection === "claude-code-plugins";
      return {
        settingsSection: nextSection,
        pluginSettingsIntent: resetMarketplaceIntent
          ? null
          : state.pluginSettingsIntent,
        pluginSettingsRepoId: resetMarketplaceIntent
          ? null
          : state.pluginSettingsRepoId,
        pluginSettingsTab: resetMarketplaceIntent
          ? "available"
          : state.pluginSettingsTab,
      };
    }),
  pluginSettingsTab: "available",
  pluginSettingsRepoId: null,
  pluginSettingsIntent: null,
  pluginRefreshToken: 0,
  openPluginSettings: (intent = {}) =>
    set((state) => {
      if (!state.pluginManagementEnabled) {
        return {};
      }
      const mergedIntent: PluginSettingsIntent = {
        action: intent.action ?? null,
        repoId: intent.repoId ?? null,
        scope: intent.scope ?? "user",
        source: intent.source ?? null,
        tab: intent.tab ?? state.pluginSettingsTab,
        target: intent.target ?? null,
      };
      return {
        settingsOpen: true,
        settingsSection: "claude-code-plugins",
        pluginSettingsTab: mergedIntent.tab,
        pluginSettingsRepoId: mergedIntent.repoId,
        pluginSettingsIntent: mergedIntent,
      };
    }),
  setPluginSettingsTab: (tab) => set({ pluginSettingsTab: tab }),
  setPluginSettingsRepoId: (repoId) => set({ pluginSettingsRepoId: repoId }),
  clearPluginSettingsIntent: () => set({ pluginSettingsIntent: null }),
  voiceProviderFocus: null,
  focusVoiceProvider: (providerId) => set({ voiceProviderFocus: providerId }),
  bumpPluginRefreshToken: () =>
    set((state) => ({ pluginRefreshToken: state.pluginRefreshToken + 1 })),

  // Modals
  activeModal: null,
  modalData: {},
  openModal: (name, data = {}) => set({ activeModal: name, modalData: data }),
  closeModal: () => set({ activeModal: null, modalData: {} }),

  // Chat input prefill
  chatInputPrefill: null,
  setChatInputPrefill: (text) => set({ chatInputPrefill: text }),
  pendingAttachmentsPrefill: null,
  setPendingAttachmentsPrefill: (atts) =>
    set({ pendingAttachmentsPrefill: atts }),
});
