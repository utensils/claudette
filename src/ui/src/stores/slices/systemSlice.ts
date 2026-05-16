import type { StateCreator } from "zustand";
import {
  fileDialogCapability,
  getAnalyticsMetrics,
  getDashboardMetrics,
  getWorkspaceMetricsBatch,
} from "../../services/tauri";
import type { SlashCommand } from "../../services/tauri";
import type { ClaudeCodeUsage } from "../../types/usage";
import type {
  AnalyticsMetrics,
  DashboardMetrics,
  WorkspaceMetrics,
} from "../../types/metrics";
import type { AppState } from "../useAppStore";

export interface SystemSlice {
  // Claude Code Usage
  claudeCodeUsage: ClaudeCodeUsage | null;
  setClaudeCodeUsage: (usage: ClaudeCodeUsage | null) => void;

  // Metrics
  dashboardMetrics: DashboardMetrics | null;
  analyticsMetrics: AnalyticsMetrics | null;
  workspaceMetrics: Record<string, WorkspaceMetrics>;
  metricsError: string | null;
  setDashboardMetrics: (metrics: DashboardMetrics | null) => void;
  setAnalyticsMetrics: (metrics: AnalyticsMetrics | null) => void;
  setWorkspaceMetrics: (metrics: Record<string, WorkspaceMetrics>) => void;
  fetchDashboardMetrics: () => Promise<void>;
  fetchAnalyticsMetrics: () => Promise<void>;
  fetchWorkspaceMetricsBatch: (ids: string[]) => Promise<void>;

  // Updater
  updateAvailable: boolean;
  updateVersion: string | null;
  updateDismissed: boolean;
  updateInstallWhenIdle: boolean;
  updateDownloading: boolean;
  updateProgress: number;
  updateChannel: "stable" | "nightly";
  updateError: string | null;
  setUpdateAvailable: (available: boolean, version: string | null) => void;
  setUpdateDismissed: (dismissed: boolean) => void;
  setUpdateInstallWhenIdle: (enabled: boolean) => void;
  setUpdateDownloading: (downloading: boolean) => void;
  setUpdateProgress: (progress: number) => void;
  setUpdateChannel: (channel: "stable" | "nightly") => void;
  setUpdateError: (error: string | null) => void;

  // App info
  appVersion: string | null;
  setAppVersion: (version: string | null) => void;

  // Slash commands (shared so native dispatch can honor file-based shadows)
  slashCommandsByWorkspace: Record<string, SlashCommand[]>;
  setSlashCommands: (wsId: string, cmds: SlashCommand[]) => void;

  // Native file-picker availability. `null` until the boot-time probe
  // completes; afterwards either true (Tauri's dialog plugin will
  // work) or false (Linux without xdg-desktop-portal — Browse
  // buttons should hide rather than crash the app). Components
  // should treat `null` like "available" so the UI isn't briefly
  // missing controls during the ~200 ms boot probe.
  fileDialogAvailable: boolean | null;
  fetchFileDialogCapability: () => Promise<void>;
}

export const createSystemSlice: StateCreator<
  AppState,
  [],
  [],
  SystemSlice
> = (set) => ({
  claudeCodeUsage: null,
  setClaudeCodeUsage: (usage) => set({ claudeCodeUsage: usage }),

  dashboardMetrics: null,
  analyticsMetrics: null,
  workspaceMetrics: {},
  metricsError: null,
  setDashboardMetrics: (metrics) =>
    set({ dashboardMetrics: metrics, metricsError: null }),
  setAnalyticsMetrics: (metrics) =>
    set({ analyticsMetrics: metrics, metricsError: null }),
  setWorkspaceMetrics: (metrics) => set({ workspaceMetrics: metrics }),
  fetchDashboardMetrics: async () => {
    try {
      const metrics = await getDashboardMetrics();
      set({ dashboardMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },
  fetchAnalyticsMetrics: async () => {
    try {
      const metrics = await getAnalyticsMetrics();
      set({ analyticsMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },
  fetchWorkspaceMetricsBatch: async (ids) => {
    if (ids.length === 0) {
      set({ workspaceMetrics: {}, metricsError: null });
      return;
    }
    try {
      const metrics = await getWorkspaceMetricsBatch(ids);
      set({ workspaceMetrics: metrics, metricsError: null });
    } catch (e) {
      set({ metricsError: String(e) });
    }
  },

  updateAvailable: false,
  updateVersion: null,
  updateDismissed: false,
  updateInstallWhenIdle: false,
  updateDownloading: false,
  updateProgress: 0,
  updateChannel: "stable",
  updateError: null,
  setUpdateAvailable: (available, version) =>
    set((state) => ({
      updateAvailable: available,
      updateVersion: version,
      updateDismissed:
        version === state.updateVersion ? state.updateDismissed : false,
      updateError: null,
    })),
  setUpdateDismissed: (dismissed) => set({ updateDismissed: dismissed }),
  setUpdateInstallWhenIdle: (enabled) =>
    set({ updateInstallWhenIdle: enabled }),
  setUpdateDownloading: (downloading) =>
    set((state) => ({
      updateDownloading: downloading,
      updateError: downloading ? null : state.updateError,
    })),
  setUpdateProgress: (progress) => set({ updateProgress: progress }),
  setUpdateChannel: (channel) =>
    set({
      updateChannel: channel,
      updateAvailable: false,
      updateVersion: null,
      updateDismissed: false,
      updateInstallWhenIdle: false,
      updateError: null,
    }),
  setUpdateError: (error) => set({ updateError: error }),

  appVersion: null,
  setAppVersion: (version) => set({ appVersion: version }),

  slashCommandsByWorkspace: {},
  setSlashCommands: (wsId, cmds) =>
    set((s) => ({
      slashCommandsByWorkspace: { ...s.slashCommandsByWorkspace, [wsId]: cmds },
    })),

  fileDialogAvailable: null,
  fetchFileDialogCapability: async () => {
    try {
      const available = await fileDialogCapability();
      set({ fileDialogAvailable: available });
    } catch {
      // If the command itself fails, default to "available" rather
      // than "missing" — the alternative is hiding Browse buttons
      // on a working system because of a transient IPC hiccup.
      set({ fileDialogAvailable: true });
    }
  },
});
