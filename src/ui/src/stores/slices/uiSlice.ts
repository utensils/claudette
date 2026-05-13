import type { StateCreator } from "zustand";
import type { AttachmentInput } from "../../types";
import type {
  PluginSettingsIntent,
  PluginSettingsTab,
} from "../../types/plugins";
import type { AppState } from "../useAppStore";

export interface ClaudeAuthFailureState {
  messageId: string | null;
  error: string;
}

/** Pull the `tool` token out of a missing-CLI payload (the Tauri event
 *  shape declared in `src-tauri/src/missing_cli.rs::MissingCli`). Used by
 *  the missing-CLI dismissal logic — kept narrow so it's safe against the
 *  loosely-typed `Record<string, unknown>` we pass through `modalData`. */
function readTool(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const v = payload.tool;
  return typeof v === "string" && v.length > 0 ? v : null;
}

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
  /** Force a repo group expanded — used after workspace creation so a
   *  freshly minted workspace is never hidden inside a collapsed parent. */
  expandRepo: (id: string) => void;
  toggleStatusGroupCollapsed: (id: string) => void;
  toggleFuzzyFinder: () => void;
  toggleCommandPalette: () => void;
  openCommandPaletteFileMode: () => void;
  clearCommandPaletteInitialMode: () => void;

  // Settings page
  settingsOpen: boolean;
  settingsSection: string | null;
  settingsFocus: string | null;
  openSettings: (section?: string, focus?: string | null) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  clearSettingsFocus: () => void;
  claudeAuthFailure: ClaudeAuthFailureState | null;
  resolvedClaudeAuthFailureMessageId: string | null;
  chatAuthLoginPanelOpen: boolean;
  chatAuthLoginRequestId: number;
  chatAuthLoginStartedRequestId: number | null;
  setClaudeAuthFailure: (failure: ClaudeAuthFailureState | null) => void;
  setResolvedClaudeAuthFailureMessageId: (messageId: string | null) => void;
  openChatAuthLoginPanel: () => void;
  setChatAuthLoginStartedRequestId: (requestId: number | null) => void;
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

  /** Latest missing-CLI guidance reported by the backend.
   *
   *  Cached so any surface that wants to re-open the modal on demand (e.g.
   *  `ChatErrorBanner`'s inline "View install options" link) can do so
   *  without re-fetching from the backend. */
  lastMissingCli: Record<string, unknown> | null;
  setLastMissingCli: (data: Record<string, unknown> | null) => void;

  /** Tools the user has explicitly dismissed the missing-CLI modal for in
   *  this app session. The first time the backend emits a `missing-dependency`
   *  for a tool, the modal auto-opens (so non-chat surfaces — auth,
   *  repository, SCM, plugin settings — still surface install guidance the
   *  way they always have). After the user closes the modal, subsequent
   *  events for the same tool only refresh the cache; the auto-open is
   *  suppressed so a high-frequency surface like chat-send doesn't
   *  re-pop the modal on every retry. The inline link still opens the
   *  modal on demand and clears the dismissal — see
   *  [`openMissingCliModal`]. */
  missingCliDismissedTools: string[];
  /** Auto-open hook fired by the `missing-dependency` listener — caches
   *  the guidance and opens the modal unless the tool is in the dismissed
   *  list. */
  reportMissingCli: (data: Record<string, unknown>) => void;
  /** Open `missingCli` modal using the cached guidance. Always opens
   *  (regardless of dismissal state) and clears the dismissal flag for
   *  the cached tool — explicit user action overrides snooze. No-op when
   *  no guidance has been cached yet. */
  openMissingCliModal: () => void;

  /** Latest missing-worktree path reported by the backend.
   *
   *  Mirrors `lastMissingCli` for the sibling `missing-worktree` event so
   *  per-workspace surfaces (chat banner, sidebar warning) can render a
   *  recovery affordance keyed to the path. */
  lastMissingWorktree: string | null;
  setLastMissingWorktree: (path: string | null) => void;

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
    set((s) => {
      // Maintain the "absence === expanded" invariant by deleting the key
      // when toggling back to expanded, instead of writing `false`. Without
      // this the map accumulates stale `false` entries that expandRepo
      // would otherwise need to clean up post-hoc.
      if (s.repoCollapsed[id]) {
        const next = { ...s.repoCollapsed };
        delete next[id];
        return { repoCollapsed: next };
      }
      return {
        repoCollapsed: { ...s.repoCollapsed, [id]: true },
      };
    }),
  expandRepo: (id) =>
    set((s) => {
      // No-op only when the key is truly absent (the canonical "expanded"
      // state). A present-but-`false` entry is stale and gets cleaned up
      // here so the map stays canonical regardless of how callers wrote
      // it. Avoids subscriber churn when there's nothing to do.
      if (!(id in s.repoCollapsed)) return s;
      const next = { ...s.repoCollapsed };
      delete next[id];
      return { repoCollapsed: next };
    }),
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
  settingsFocus: null,
  claudeAuthFailure: null,
  resolvedClaudeAuthFailureMessageId: null,
  chatAuthLoginPanelOpen: false,
  chatAuthLoginRequestId: 0,
  chatAuthLoginStartedRequestId: null,
  openSettings: (section = "general", focus = null) =>
    set((state) => {
      // Only `claude-code-plugins` (the Claude CLI marketplace integration)
      // is gated behind `pluginManagementEnabled`. The `plugins` section
      // (Claudette's own built-in Lua plugins — voice providers, SCM, env
      // providers) is always reachable. Routing `"plugins"` to
      // `"experimental"` was a bug where the voice-error → Plugins flow
      // landed on the wrong page when plugin management was off, hiding
      // the Distil-Whisper "Download model" button the user was sent
      // there to click. setSettingsSection (below) already gets this
      // distinction right; openSettings now matches.
      const nextSection =
        section === "claude-code-plugins" && !state.pluginManagementEnabled
          ? "experimental"
          : section;
      const resetMarketplaceIntent = nextSection === "claude-code-plugins";
      return {
        settingsOpen: true,
        settingsSection: nextSection,
        settingsFocus: focus,
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
  closeSettings: () =>
    set({
      settingsOpen: false,
      settingsSection: null,
      settingsFocus: null,
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
        settingsFocus: null,
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
  clearSettingsFocus: () => set({ settingsFocus: null }),
  setClaudeAuthFailure: (failure) => set({ claudeAuthFailure: failure }),
  setResolvedClaudeAuthFailureMessageId: (messageId) =>
    set({ resolvedClaudeAuthFailureMessageId: messageId }),
  openChatAuthLoginPanel: () =>
    set((state) => ({
      chatAuthLoginPanelOpen: true,
      chatAuthLoginRequestId: state.chatAuthLoginRequestId + 1,
    })),
  setChatAuthLoginStartedRequestId: (requestId) =>
    set({ chatAuthLoginStartedRequestId: requestId }),
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
        settingsFocus: null,
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
  closeModal: () =>
    set((state) => {
      // Closing the missing-CLI modal records a per-tool dismissal so the
      // listener won't auto-reopen for the same tool on every subsequent
      // missing-dependency event. Inline links and explicit
      // `openMissingCliModal()` calls clear this and re-show.
      if (state.activeModal === "missingCli") {
        const tool = readTool(state.modalData);
        if (tool && !state.missingCliDismissedTools.includes(tool)) {
          return {
            activeModal: null,
            modalData: {},
            missingCliDismissedTools: [...state.missingCliDismissedTools, tool],
          };
        }
      }
      return { activeModal: null, modalData: {} };
    }),
  lastMissingCli: null,
  missingCliDismissedTools: [],
  setLastMissingCli: (data) => set({ lastMissingCli: data }),
  reportMissingCli: (data) =>
    set((state) => {
      const tool = readTool(data);
      const dismissed = tool ? state.missingCliDismissedTools.includes(tool) : false;
      // Always cache so explicit reopen has a fresh payload to render.
      // Auto-open only when not dismissed — i.e. first time per tool, or
      // after the user clicked the inline link to bring it back.
      if (dismissed) {
        return { lastMissingCli: data };
      }
      return {
        lastMissingCli: data,
        activeModal: "missingCli",
        modalData: data,
      };
    }),
  openMissingCliModal: () =>
    set((state) => {
      if (!state.lastMissingCli) return {};
      const tool = readTool(state.lastMissingCli);
      const dismissed = state.missingCliDismissedTools;
      const nextDismissed = tool ? dismissed.filter((t) => t !== tool) : dismissed;
      return {
        activeModal: "missingCli",
        modalData: state.lastMissingCli,
        missingCliDismissedTools: nextDismissed,
      };
    }),
  lastMissingWorktree: null,
  setLastMissingWorktree: (path) => set({ lastMissingWorktree: path }),

  // Chat input prefill
  chatInputPrefill: null,
  setChatInputPrefill: (text) => set({ chatInputPrefill: text }),
  pendingAttachmentsPrefill: null,
  setPendingAttachmentsPrefill: (atts) =>
    set({ pendingAttachmentsPrefill: atts }),
});
