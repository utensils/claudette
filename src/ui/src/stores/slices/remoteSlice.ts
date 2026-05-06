import type { StateCreator } from "zustand";
import type {
  RemoteConnectionInfo,
  DiscoveredServer,
} from "../../types";
import type { RemoteInitialData } from "../../types/remote";
import type { McpStatusSnapshot } from "../../types/mcp";
import type { DetectedApp } from "../../types/apps";
import type { AppState } from "../useAppStore";

export interface RemoteSlice {
  // Remote Connections
  remoteConnections: RemoteConnectionInfo[];
  discoveredServers: DiscoveredServer[];
  activeRemoteIds: string[];
  setRemoteConnections: (conns: RemoteConnectionInfo[]) => void;
  addRemoteConnection: (conn: RemoteConnectionInfo) => void;
  removeRemoteConnection: (id: string) => void;
  setDiscoveredServers: (servers: DiscoveredServer[]) => void;
  setActiveRemoteIds: (ids: string[]) => void;
  addActiveRemoteId: (id: string) => void;
  removeActiveRemoteId: (id: string) => void;
  mergeRemoteData: (connectionId: string, data: RemoteInitialData) => void;
  clearRemoteData: (connectionId: string) => void;

  // Local Server
  localServerRunning: boolean;
  localServerConnectionString: string | null;
  setLocalServerRunning: (running: boolean) => void;
  setLocalServerConnectionString: (cs: string | null) => void;

  // Workspace-scoped collaborative shares. Number of currently-active
  // shares the host has minted (independent of the legacy
  // `localServerRunning` flag — the new model can have shares live
  // without the legacy subprocess server). Surfaced so the sidebar
  // ShareButton can show the right active/inactive styling.
  activeSharesCount: number;
  setActiveSharesCount: (count: number) => void;

  // MCP Status (per-repository)
  mcpStatus: Record<string, McpStatusSnapshot>;
  setMcpStatus: (repoId: string, snapshot: McpStatusSnapshot) => void;
  clearMcpStatus: (repoId: string) => void;

  // Detected Apps
  detectedApps: DetectedApp[];
  setDetectedApps: (apps: DetectedApp[]) => void;
}

export const createRemoteSlice: StateCreator<
  AppState,
  [],
  [],
  RemoteSlice
> = (set) => ({
  remoteConnections: [],
  discoveredServers: [],
  activeRemoteIds: [],
  setRemoteConnections: (conns) => set({ remoteConnections: conns }),
  addRemoteConnection: (conn) =>
    set((s) => ({ remoteConnections: [...s.remoteConnections, conn] })),
  removeRemoteConnection: (id) =>
    set((s) => ({
      remoteConnections: s.remoteConnections.filter((c) => c.id !== id),
      activeRemoteIds: s.activeRemoteIds.filter((rid) => rid !== id),
    })),
  setDiscoveredServers: (servers) => set({ discoveredServers: servers }),
  setActiveRemoteIds: (ids) => set({ activeRemoteIds: ids }),
  addActiveRemoteId: (id) =>
    set((s) => ({
      activeRemoteIds: s.activeRemoteIds.includes(id)
        ? s.activeRemoteIds
        : [...s.activeRemoteIds, id],
    })),
  removeActiveRemoteId: (id) =>
    set((s) => ({
      activeRemoteIds: s.activeRemoteIds.filter((rid) => rid !== id),
    })),
  mergeRemoteData: (connectionId, data) =>
    set((s) => {
      // Tag remote repos and workspaces with the connection ID, then merge.
      const taggedRepos = data.repositories.map((r) => ({
        ...r,
        remote_connection_id: connectionId,
      }));
      const taggedWorkspaces = data.workspaces.map((w) => ({
        ...w,
        remote_connection_id: connectionId,
      }));
      // Merge remote repo default branches so review-workflow prompts and any
      // other UI keyed off `defaultBranches[repo.id]` work for paired servers.
      // Prune using the repos *previously* stored for this connection so
      // entries for repos removed from the latest payload don't linger.
      const previousRemoteRepoIds = new Set(
        s.repositories
          .filter((r) => r.remote_connection_id === connectionId)
          .map((r) => r.id),
      );
      const prunedDefaults = Object.fromEntries(
        Object.entries(s.defaultBranches).filter(
          ([id]) => !previousRemoteRepoIds.has(id),
        ),
      );
      return {
        repositories: [
          ...s.repositories.filter(
            (r) => r.remote_connection_id !== connectionId,
          ),
          ...taggedRepos,
        ],
        workspaces: [
          ...s.workspaces.filter(
            (w) => w.remote_connection_id !== connectionId,
          ),
          ...taggedWorkspaces,
        ],
        defaultBranches: { ...prunedDefaults, ...data.default_branches },
      };
    }),
  clearRemoteData: (connectionId) =>
    set((s) => {
      const clearedRepoIds = new Set(
        s.repositories
          .filter((r) => r.remote_connection_id === connectionId)
          .map((r) => r.id),
      );
      const prunedDefaults = Object.fromEntries(
        Object.entries(s.defaultBranches).filter(([id]) => !clearedRepoIds.has(id)),
      );
      return {
        repositories: s.repositories.filter(
          (r) => r.remote_connection_id !== connectionId,
        ),
        workspaces: s.workspaces.filter(
          (w) => w.remote_connection_id !== connectionId,
        ),
        defaultBranches: prunedDefaults,
      };
    }),

  // Local Server
  localServerRunning: false,
  localServerConnectionString: null,
  setLocalServerRunning: (running) => set({ localServerRunning: running }),
  setLocalServerConnectionString: (cs) =>
    set({ localServerConnectionString: cs }),

  // Active shares count
  activeSharesCount: 0,
  setActiveSharesCount: (count) => set({ activeSharesCount: count }),

  // MCP Status
  mcpStatus: {},
  setMcpStatus: (repoId, snapshot) =>
    set((state) => ({
      mcpStatus: { ...state.mcpStatus, [repoId]: snapshot },
    })),
  clearMcpStatus: (repoId) =>
    set((state) => {
      const { [repoId]: _, ...rest } = state.mcpStatus;
      return { mcpStatus: rest };
    }),

  // Detected Apps
  detectedApps: [],
  setDetectedApps: (apps) => set({ detectedApps: apps }),
});
