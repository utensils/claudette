import { useAppStore } from "../../stores/useAppStore";

// Match POSIX absolute paths pointing at `.claude/plans/*.md`. Allows spaces
// in directory segments (macOS home directories with spaces are legitimate)
// but keeps the filename portion on a single path segment — otherwise a
// stretch of prose like "see /a/.claude/plans/x.txt or /b/y.md" would match
// across the intermediate directory boundary. Windows-style drive paths are
// intentionally not matched — Claudette only targets macOS and Linux (see
// CLAUDE.md).
const PLAN_PATH_RE =
  /(\/[^\r\n)"`]*?\/\.claude\/plans\/[^\r\n/)"`]+?\.md)(?=$|[\s)"'`.,:;!?])/;

/**
 * Locate the most recent plan file path for the given workspace by scanning
 * the current in-memory state — chat messages first (newest-first), then the
 * active streaming buffer, then tool-activity input/result text, then the
 * pending plan approval's `planFilePath`.
 *
 * Returns `null` if no `.claude/plans/*.md` path has been emitted yet.
 *
 * Used by `/plan open` so that the command keeps working after the user has
 * already approved or denied the plan approval card (which clears the
 * pending approval but leaves the plan file itself on disk).
 */
export function findLatestPlanFilePath(workspaceId: string): string | null {
  const state = useAppStore.getState();

  const messages = state.chatMessages[workspaceId] ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const match = messages[i].content.match(PLAN_PATH_RE);
    if (match) return match[1];
  }

  const streaming = state.streamingContent[workspaceId] ?? "";
  const streamingMatch = streaming.match(PLAN_PATH_RE);
  if (streamingMatch) return streamingMatch[1];

  // Tool activities are appended in insertion order, so iterate newest-first
  // to match the "most recent" contract when a workspace has produced plans
  // across multiple turns within the current session window.
  const activities = state.toolActivities[workspaceId] ?? [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    const match = (activity.inputJson + activity.resultText).match(
      PLAN_PATH_RE,
    );
    if (match) return match[1];
  }

  return state.planApprovals[workspaceId]?.planFilePath ?? null;
}
