/**
 * Recognizer for agent-managed files — plans, memory notes, and other
 * markdown that coding agents (Claude Code, Codex) persist under fixed
 * home directories, outside any worktree.
 *
 * This mirrors the backend allow-list in `src/agent_files.rs`. It exists
 * so the chat surface can decide *routing*: an allow-listed path opens in
 * a read-only Monaco tab via `read_agent_managed_file` instead of being
 * sent to the worktree file-read command, which rejects absolute paths.
 *
 * This is a routing hint, **not** a security boundary — the backend
 * `classify_agent_file` re-validates every read and canonicalizes the
 * path (resolving symlink escapes), which this string-only classifier
 * cannot. A frontend false positive surfaces as a load error; a false
 * negative just falls back to the OS opener.
 *
 * Keep the roots here in sync with `ROOTS` in `src/agent_files.rs`.
 */

import { stripFileLineSuffix } from "./filePathLinks";

export type AgentFileKind = "plan" | "memory" | "memory-index" | "project-file";

export interface AgentFileClassification {
  kind: AgentFileKind;
  /** Normalized absolute path — the stable Monaco tab key. */
  path: string;
}

/** One segment of an allow-list anchor. */
type Seg = { lit: string } | { any: true };

interface AgentFileRoot {
  /** Consecutive path segments that must appear, in order, in the path. */
  anchor: Seg[];
  /** Allowed file extensions, lowercase, without the leading dot. */
  extensions: string[];
  kind: AgentFileKind;
}

/** Evaluated top-to-bottom; first match wins, so the specific memory
 *  roots precede the broad project catch. */
const ROOTS: AgentFileRoot[] = [
  // Claude Code plans — ~/.claude/plans/**/*.md
  {
    anchor: [{ lit: ".claude" }, { lit: "plans" }],
    extensions: ["md"],
    kind: "plan",
  },
  // Claude Code project memory — ~/.claude/projects/<slug>/memory/**/*.md
  {
    anchor: [
      { lit: ".claude" },
      { lit: "projects" },
      { any: true },
      { lit: "memory" },
    ],
    extensions: ["md"],
    kind: "memory",
  },
  // Codex memory — ~/.codex/memories/**/*.md
  {
    anchor: [{ lit: ".codex" }, { lit: "memories" }],
    extensions: ["md"],
    kind: "memory",
  },
  // Broad Claude Code project catch — any other .md under a project dir.
  {
    anchor: [{ lit: ".claude" }, { lit: "projects" }, { any: true }],
    extensions: ["md"],
    kind: "project-file",
  },
];

/** True when `anchor` appears as a run of consecutive components in
 *  `components`, with at least one component (the file) following it. */
function anchorPresent(components: string[], anchor: Seg[]): boolean {
  const n = anchor.length;
  if (components.length <= n) return false;
  for (let start = 0; start + n <= components.length - 1; start++) {
    let matched = true;
    for (let i = 0; i < n; i++) {
      const seg = anchor[i];
      if ("lit" in seg && components[start + i] !== seg.lit) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Classify an absolute path against the agent-managed-file allow-list.
 * Returns the kind and normalized path, or `null` when the path is not an
 * allow-listed agent file (relative paths always return `null` — a
 * worktree tab key never starts with a slash).
 */
export function classifyAgentFile(rawPath: string): AgentFileClassification | null {
  if (!rawPath) return null;
  const normalized = stripFileLineSuffix(rawPath.trim()).replace(/\\/g, "/");
  // Only absolute paths can be agent-managed files. Workspace-relative
  // tab keys never start with a slash or a Windows drive letter.
  const isAbsolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!isAbsolute) return null;

  const components = normalized.split("/").filter((c) => c.length > 0);
  if (components.length === 0) return null;
  const basename = components[components.length - 1];
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return null;
  const ext = basename.slice(dot + 1).toLowerCase();

  for (const root of ROOTS) {
    if (!root.extensions.includes(ext)) continue;
    if (!anchorPresent(components, root.anchor)) continue;
    const kind: AgentFileKind =
      root.kind === "memory" && basename === "MEMORY.md"
        ? "memory-index"
        : root.kind;
    return { kind, path: normalized };
  }
  return null;
}

/**
 * Routing helper shared by every chat-surface file-link opener. If
 * `filePath` is an allow-listed agent-managed file, open it as a
 * read-only Monaco tab keyed by its absolute path and return `true`;
 * otherwise return `false` so the caller falls back to worktree-relative
 * resolution.
 */
export function tryOpenAgentFileTab(
  workspaceId: string | null | undefined,
  filePath: string,
  openFileTab: (workspaceId: string, path: string) => void,
): boolean {
  if (!workspaceId) return false;
  const agent = classifyAgentFile(filePath);
  if (!agent) return false;
  openFileTab(workspaceId, agent.path);
  return true;
}

/** Chat-namespace i18n key for an agent file's badge label. The literal
 *  return type keeps it assignable to the typed `t()` key parameter. */
export type AgentFileBadgeKey =
  | "agent_file_badge_plan"
  | "agent_file_badge_memory"
  | "agent_file_badge_memory_index"
  | "agent_file_badge_project";

export function agentFileKindI18nKey(kind: AgentFileKind): AgentFileBadgeKey {
  switch (kind) {
    case "plan":
      return "agent_file_badge_plan";
    case "memory":
      return "agent_file_badge_memory";
    case "memory-index":
      return "agent_file_badge_memory_index";
    case "project-file":
      return "agent_file_badge_project";
  }
}
