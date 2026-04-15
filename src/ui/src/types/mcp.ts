/** Where the MCP server configuration was detected from. */
export type McpSource =
  | "user_global_config"
  | "user_project_config"
  | "project_mcp_json"
  | "repo_local_config"
  | "plugin";

/** Human-readable labels for MCP source types (matching Claude Code's grouping). */
export const MCP_SOURCE_LABELS: Record<McpSource, string> = {
  user_global_config: "User (~/.claude.json)",
  user_project_config: "User project",
  project_mcp_json: "Project (.mcp.json)",
  repo_local_config: "Local (.claude.json)",
  plugin: "Built-in (always available)",
};

/** A detected MCP server (returned by detect_mcp_servers). */
export interface McpServer {
  name: string;
  config: Record<string, unknown>;
  source: McpSource;
}

/** A saved MCP server row from the database (returned by load_repository_mcps). */
export interface SavedMcpServer {
  id: string;
  repository_id: string;
  name: string;
  config_json: string;
  source: string;
  created_at: string;
  enabled: boolean;
}

// -- Supervisor status types --

/** Connection state tracked by the MCP supervisor. */
export type McpConnectionState =
  | "connected"
  | "pending"
  | "failed"
  | "disabled";

/** Transport type for an MCP server. */
export type McpTransportType = "stdio" | "http" | "sse";

/** Real-time status for a single supervised MCP server. */
export interface McpServerStatus {
  name: string;
  transport: McpTransportType;
  state: McpConnectionState;
  enabled: boolean;
  last_error: string | null;
  failure_count: number;
}

/** Snapshot of all MCP server states for a repository. */
export interface McpStatusSnapshot {
  repository_id: string;
  servers: McpServerStatus[];
}
