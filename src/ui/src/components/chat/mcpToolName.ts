// MCP tools surface to the agent as `mcp__<server>__<tool>` — e.g.
// `mcp__datadog__search_datadog_dashboards` (server `datadog`, tool
// `search_datadog_dashboards`). The server segment may itself contain single
// underscores (`mcp__claude_ai_Gmail__authenticate`), so the split is on the
// FIRST `__` after the prefix: a non-greedy server capture, then everything
// else as the tool.
const MCP_TOOL_PATTERN = /^mcp__(.+?)__(.+)$/;

export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  const match = MCP_TOOL_PATTERN.exec(toolName);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

export function isMcpToolName(toolName: string): boolean {
  return MCP_TOOL_PATTERN.test(toolName);
}
