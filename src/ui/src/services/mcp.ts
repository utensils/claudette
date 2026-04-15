import { invoke } from "@tauri-apps/api/core";
import type {
  McpServer,
  McpServerStatus,
  McpStatusSnapshot,
  SavedMcpServer,
} from "../types/mcp";

export function detectMcpServers(repoId: string): Promise<McpServer[]> {
  return invoke("detect_mcp_servers", { repoId });
}

export function saveRepositoryMcps(
  repoId: string,
  servers: McpServer[],
): Promise<void> {
  return invoke("save_repository_mcps", { repoId, servers });
}

export function loadRepositoryMcps(
  repoId: string,
): Promise<SavedMcpServer[]> {
  return invoke("load_repository_mcps", { repoId });
}

export function deleteRepositoryMcp(serverId: string): Promise<void> {
  return invoke("delete_repository_mcp", { serverId });
}

// -- Supervisor commands --

export function getMcpStatus(
  repoId: string,
): Promise<McpStatusSnapshot | null> {
  return invoke("get_mcp_status", { repoId });
}

/** Auto-detect, save, and validate MCP servers for a repo. Returns live status. */
export function ensureAndValidateMcps(
  repoId: string,
): Promise<McpStatusSnapshot> {
  return invoke("ensure_and_validate_mcps", { repoId });
}

export function reconnectMcpServer(
  repoId: string,
  serverName: string,
): Promise<McpServerStatus> {
  return invoke("reconnect_mcp_server", { repoId, serverName });
}

export function setMcpServerEnabled(
  serverId: string,
  repoId: string,
  serverName: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_mcp_server_enabled", {
    serverId,
    repoId,
    serverName,
    enabled,
  });
}
