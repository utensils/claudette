import { resolveToolSummary } from "../components/chat/toolMetadata";

/**
 * Extract a short human-readable summary from a tool's input JSON.
 *
 * Most logic lives in `components/chat/toolMetadata.ts` so the same
 * registry can power richer surfaces (e.g. a future expand-to-code-block
 * view with syntax highlighting). This wrapper exists because a few
 * built-in tools (`Grep`, `SendMessage`, `Skill`, `TaskUpdate`, …)
 * compose two fields into the displayed summary, which the registry's
 * single-content-field model can't express. Those keep their bespoke
 * formatting here; everything else delegates to the registry.
 */
export function extractToolSummary(
  toolName: string,
  inputJson: string,
): string {
  // Composite-summary tools: keep their hand-rolled formatting because
  // the registry returns a single `contentField`'s value, not a
  // string built from multiple fields.
  try {
    const input = JSON.parse(inputJson);
    switch (toolName) {
      case "Grep":
        return input.pattern
          ? `${input.pattern}${input.path ? ` in ${input.path}` : ""}`
          : "";
      case "SendMessage":
        return input.to
          ? `to ${input.to}${input.summary ? `: ${input.summary}` : ""}`
          : "";
      case "Skill":
        return input.skill
          ? `${input.skill}${input.args ? ` ${input.args}` : ""}`
          : "";
      case "TaskUpdate":
        return input.status ? `#${input.id ?? "?"} → ${input.status}` : "";
      case "TaskGet":
      case "TaskStop":
      case "TaskOutput":
        return input.id ? `#${input.id}` : "";
      case "Monitor":
        return input.id ? `task #${input.id}` : "";
      case "CronDelete":
        return input.id ?? input.name ?? "";
      case "RemoteTrigger":
        return input.name ?? input.prompt ?? "";
      case "LSP":
        return input.action ?? "";
    }
  } catch {
    return "";
  }
  // Default path: registry → tool-name heuristics → field-name
  // heuristics → longest string.
  return resolveToolSummary(toolName, inputJson).summary;
}

/** Strip the workspace root prefix from a summary string, leaving a relative path.
 *  Handles both POSIX (`/`) and Windows (`\`) separators since `worktree_path`
 *  is canonicalized to a backslash drive-letter path on Windows. */
export function relativizePath(
  text: string,
  root: string | null | undefined
): string {
  if (!root || !text) return text;
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  if (!normalizedRoot) return text;
  return text
    .replaceAll(normalizedRoot + "/", "")
    .replaceAll(normalizedRoot + "\\", "");
}
