import { invoke } from "@tauri-apps/api/core";
import type { McpServer, SavedMcpServer } from "../types/mcp";

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
