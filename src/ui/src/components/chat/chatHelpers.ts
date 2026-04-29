import { MODELS } from "./modelRegistry";

export function shouldDisable1mContext(modelId: string | null): boolean {
  if (!modelId) return false;
  const entry = MODELS.find((m) => m.id === modelId);
  return entry ? entry.contextWindowTokens < 1_000_000 : false;
}

/** Format a duration in seconds as "15s" or "2m 34s". */
export function formatElapsedSeconds(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

/** Format a duration in milliseconds as "15s" or "2m 34s". Sub-second turns
 *  round up to "1s" so the footer always shows something meaningful. */
export function formatDurationMs(ms: number): string {
  return formatElapsedSeconds(Math.max(1, Math.floor(ms / 1000)));
}

/** Semantic colors for tool names — makes tool activity scannable at a glance. */
export const TOOL_COLORS: Record<string, string> = {
  Read: "var(--tool-read)",
  Glob: "var(--tool-read)",
  Grep: "var(--tool-read)",
  Write: "var(--tool-write)",
  Edit: "var(--tool-edit)",
  Bash: "var(--tool-bash)",
  WebSearch: "var(--tool-web)",
  WebFetch: "var(--tool-web)",
  Agent: "var(--tool-agent)",
  AskUserQuestion: "var(--accent-primary)",
};

export function toolColor(name: string): string {
  return TOOL_COLORS[name] ?? "var(--text-muted)";
}
