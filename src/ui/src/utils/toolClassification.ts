export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Task",
  "Agent",
]);

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}
