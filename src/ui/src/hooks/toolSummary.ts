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
          ? `${input.pattern}${input.path ? ` in ${input.path}` : ""}`
          : "";
      case "WebFetch":
        return input.url ?? "";
      case "WebSearch":
        return input.query ?? "";
      case "NotebookEdit":
        return input.notebook_path ?? "";
      case "LSP":
        return input.action ?? "";
      case "TodoWrite":
        return input.todos
          ? `${(input.todos as unknown[]).length} items`
          : "";
      default:
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
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}
