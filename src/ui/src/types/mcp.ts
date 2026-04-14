/** Where the MCP server configuration was detected from. */
export type McpSource = "user_project_config" | "repo_local_config";

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
}
