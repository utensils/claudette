/** Extract a short human-readable summary from a tool's input JSON. */
export function extractToolSummary(
  toolName: string,
  inputJson: string
): string {
  try {
    const input = JSON.parse(inputJson);

    switch (toolName) {
      case "Bash":
        return truncate(input.command ?? input.description ?? "", 80);
      case "Read":
        return input.file_path ?? "";
      case "Edit":
        return input.file_path ?? "";
      case "Write":
        return input.file_path ?? "";
      case "Glob":
        return input.pattern ?? "";
      case "Grep":
        return input.pattern
          ? truncate(`${input.pattern}${input.path ? ` in ${input.path}` : ""}`, 80)
          : "";
      case "WebFetch":
        return input.url ?? "";
      case "WebSearch":
        return input.query ?? "";
      case "NotebookEdit":
        return input.notebook_path ?? "";
      case "Agent":
        return truncate(input.description ?? input.prompt ?? "", 80);
      case "SendMessage":
        return input.to
          ? truncate(`to ${input.to}${input.summary ? `: ${input.summary}` : ""}`, 80)
          : "";
      case "ToolSearch":
        return input.query ?? "";
      case "TeamCreate":
        return input.name ?? "";
      case "TeamDelete":
        return input.name ?? "";
      case "TaskCreate":
        return truncate(input.description ?? "", 80);
      case "TaskUpdate":
        return input.status ? `#${input.id ?? "?"} → ${input.status}` : "";
      case "TaskGet":
      case "TaskStop":
      case "TaskOutput":
        return input.id ? `#${input.id}` : "";
      case "Skill":
        return input.skill
          ? truncate(`${input.skill}${input.args ? ` ${input.args}` : ""}`, 80)
          : "";
      case "AskUserQuestion":
        return truncate(input.question ?? "", 80);
      case "Monitor":
        return input.id ? `task #${input.id}` : "";
      case "CronCreate":
        return truncate(input.schedule ?? input.name ?? "", 80);
      case "CronDelete":
        return input.id ?? input.name ?? "";
      case "RemoteTrigger":
        return truncate(input.name ?? input.prompt ?? "", 80);
      case "LSP":
        return input.action ?? "";
      case "TodoWrite":
        return Array.isArray(input.todos)
          ? `${input.todos.length} items`
          : "";
      default: {
        // MCP tools: strip the mcp__ prefix for readability.
        if (toolName.startsWith("mcp__")) {
          return truncate(
            input.description ?? input.url ?? input.query ?? input.command ?? "",
            80
          );
        }
        // For unknown tools, try common field names.
        return truncate(
          input.command ??
            input.file_path ??
            input.path ??
            input.query ??
            input.url ??
            "",
          80
        );
      }
    }
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return s.slice(0, max - 3) + "...";
}

/** Strip the workspace root prefix from a summary string, leaving a relative path. */
export function relativizePath(
  text: string,
  root: string | null | undefined
): string {
  if (!root || !text) return text;
  const prefix = root.endsWith("/") ? root : root + "/";
  return text.replaceAll(prefix, "");
}
